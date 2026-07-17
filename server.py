from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import csv
import json
import os
import re
import sqlite3
from datetime import datetime

ROOT = Path(__file__).resolve().parent
INPUT_DIR = ROOT / "input"
DB_PATH = Path(os.environ.get("DEMO_DB_PATH", ROOT / "abc_mentor_demo.sqlite3"))
ACCESS_CODE = os.environ.get("DEMO_ACCESS_CODE", "").strip()


def split_tags(value):
    return [item.strip() for item in re.split(r"[;；、,，]+", value or "") if item.strip()]


def now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = db()
    cur = conn.cursor()
    cur.executescript(
        """
        create table if not exists mentors (
          id text primary key,
          name text not null,
          school text,
          industry text,
          title text,
          interests text,
          projects text,
          topics text,
          message text
        );
        create table if not exists students (
          id text primary key,
          name text not null,
          school text,
          major text,
          interests text,
          pre_agreed_mentor text,
          intended_mentor text,
          experience text,
          message text
        );
        create table if not exists applications (
          student_id text primary key,
          mentor_id text not null,
          status text not null default 'pending',
          created_at text not null
        );
        create table if not exists pools (
          mentor_id text not null,
          student_id text not null,
          match_percent integer not null,
          reason text not null,
          is_manual integer not null default 0,
          primary key (mentor_id, student_id)
        );
        create table if not exists decisions (
          mentor_id text not null,
          student_id text not null,
          decision text not null,
          updated_at text not null,
          primary key (mentor_id, student_id)
        );
        create table if not exists feedback (
          id integer primary key autoincrement,
          thread_id integer,
          from_role text not null,
          from_name text not null,
          to_role text not null,
          content text not null,
          created_at text not null
        );
        create table if not exists admin_actions (
          id integer primary key autoincrement,
          action text not null,
          detail text not null,
          created_at text not null
        );
        create table if not exists round_state (
          id integer primary key check (id = 1),
          current_round integer not null default 1,
          round1_closed integer not null default 0,
          round2_closed integer not null default 0,
          round3_closed integer not null default 0
        );
        create table if not exists round_applications (
          id integer primary key autoincrement,
          round integer not null,
          student_id text not null,
          mentor_id text not null,
          preference_rank integer,
          message text,
          status text not null default 'submitted',
          created_at text not null
        );
        create unique index if not exists idx_round_app_unique
          on round_applications(round, student_id, mentor_id);
        create table if not exists matches (
          student_id text primary key,
          mentor_id text not null,
          round integer not null,
          created_at text not null
        );
        create table if not exists notifications (
          id integer primary key autoincrement,
          student_id text not null,
          round integer not null,
          message text not null,
          created_at text not null
        );
        create table if not exists mentor_settings (
          mentor_id text primary key,
          capacity integer not null default 3
        );
        create table if not exists student_round_choices (
          student_id text not null,
          round integer not null,
          choice text not null,
          created_at text not null,
          primary key(student_id, round)
        );
        """
    )
    cur.execute("insert or ignore into round_state(id, current_round, round1_closed, round2_closed, round3_closed) values (1, 1, 0, 0, 0)")

    if cur.execute("select count(*) from mentors").fetchone()[0] == 0:
        with (INPUT_DIR / "mentors.csv").open(newline="", encoding="utf-8") as file:
            for index, row in enumerate(csv.DictReader(file), start=1):
                cur.execute(
                    "insert into mentors values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        f"m{index}",
                        row["name"],
                        row["school"],
                        row["industry"],
                        row["title"],
                        row["interests"],
                        row["projects"],
                        row["topics"],
                        row["message"],
                    ),
                )

    if cur.execute("select count(*) from students").fetchone()[0] == 0:
        with (INPUT_DIR / "students.csv").open(newline="", encoding="utf-8") as file:
            for index, row in enumerate(csv.DictReader(file), start=1):
                cur.execute(
                    "insert into students values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        f"s{index}",
                        row["name"],
                        row["school"],
                        row["major"],
                        row["interests"],
                        row["pre_agreed_mentor"],
                        row["intended_mentor"],
                        row["experience"],
                        row["message"],
                    ),
                )

    conn.commit()
    conn.close()
    run_matching()


def rows(table):
    conn = db()
    data = [dict(row) for row in conn.execute(f"select * from {table}")]
    conn.close()
    return data


def score_match(student, mentor):
    student_interests = split_tags(student["interests"])
    mentor_interests = split_tags(mentor["interests"])
    shared = len([item for item in student_interests if item in mentor_interests])
    interest_score = min(shared * 20, 40)
    text = f"{student['major']} {student['experience']} {student['message']} {student['interests']}".lower()
    target = f"{mentor['industry']} {mentor['title']} {mentor['projects']} {mentor['topics']} {mentor['message']} {mentor['interests']}".lower()
    words = [word for word in re.split(r"[\s,，、。；;：:]+", text) if word]
    overlap = [word for word in words if any(word in other or other in word for other in re.split(r"[\s,，、。；;：:]+", target) if other)]
    text_score = min(len(overlap) * 6, 45)
    intention_score = 10 if student["intended_mentor"] == mentor["name"] else 0
    pre_agreed_score = 20 if student["pre_agreed_mentor"] == mentor["name"] else 0
    return min(100, interest_score + text_score + intention_score + pre_agreed_score)


def match_reason(student, mentor):
    if student["pre_agreed_mentor"] == mentor["name"]:
        return "已提前约定"
    if student["intended_mentor"] == mentor["name"]:
        return "已有意向导师"
    return "问卷匹配度"


def run_matching():
    conn = db()
    cur = conn.cursor()
    mentors = [dict(row) for row in cur.execute("select * from mentors")]
    students = {row["id"]: dict(row) for row in cur.execute("select * from students")}
    manual = [dict(row) for row in cur.execute("select * from pools where is_manual = 1")]
    cur.execute("delete from pools where is_manual = 0")

    for mentor in mentors:
        applications = [dict(row) for row in cur.execute("select * from applications where mentor_id = ?", (mentor["id"],))]
        applicants = []
        for app in applications:
            student = students[app["student_id"]]
            applicants.append(
                {
                    "mentor_id": mentor["id"],
                    "student_id": student["id"],
                    "match_percent": score_match(student, mentor),
                    "reason": match_reason(student, mentor),
                }
            )
        selected = applicants
        if len(applicants) > 8:
            pre_agreed = [item for item in applicants if students[item["student_id"]]["pre_agreed_mentor"] == mentor["name"]]
            if len(pre_agreed) > 8:
                selected = sorted(applicants, key=lambda item: item["match_percent"], reverse=True)[:8]
            else:
                selected = list(pre_agreed)
                selected_ids = {item["student_id"] for item in selected}
                intended = [
                    item
                    for item in applicants
                    if item["student_id"] not in selected_ids and students[item["student_id"]]["intended_mentor"] == mentor["name"]
                ]
                selected.extend(sorted(intended, key=lambda item: item["match_percent"], reverse=True)[: 8 - len(selected)])
                selected_ids = {item["student_id"] for item in selected}
                remaining = [item for item in applicants if item["student_id"] not in selected_ids]
                selected.extend(sorted(remaining, key=lambda item: item["match_percent"], reverse=True)[: 8 - len(selected)])

        for item in selected:
            cur.execute(
                "insert or ignore into pools values (?, ?, ?, ?, 0)",
                (item["mentor_id"], item["student_id"], item["match_percent"], item["reason"]),
            )

    for item in manual:
        cur.execute(
            "insert or replace into pools values (?, ?, ?, ?, 1)",
            (item["mentor_id"], item["student_id"], item["match_percent"], item["reason"]),
        )

    sync_statuses(cur)
    conn.commit()
    conn.close()


def sync_statuses(cur):
    applications = [dict(row) for row in cur.execute("select * from applications")]
    for app in applications:
        decision = cur.execute(
            "select decision from decisions where mentor_id = ? and student_id = ?",
            (app["mentor_id"], app["student_id"]),
        ).fetchone()
        if decision:
            status = "accepted" if decision["decision"] == "accepted" else "rejected"
        else:
            in_pool = cur.execute(
                "select 1 from pools where mentor_id = ? and student_id = ?",
                (app["mentor_id"], app["student_id"]),
            ).fetchone()
            status = "in_pool" if in_pool else "not_matched"
        cur.execute("update applications set status = ? where student_id = ?", (status, app["student_id"]))


def round_state(cur):
    return dict(cur.execute("select * from round_state where id = 1").fetchone())


def mentor_match_count(cur, mentor_id):
    return cur.execute("select count(*) from matches where mentor_id = ?", (mentor_id,)).fetchone()[0]


def mentor_preaccepted_count(cur, mentor_id):
    return cur.execute(
        "select count(*) from round_applications where round = 1 and mentor_id = ? and status = 'preaccepted'",
        (mentor_id,),
    ).fetchone()[0]


def mentor_capacity(cur, mentor_id):
    row = cur.execute("select capacity from mentor_settings where mentor_id = ?", (mentor_id,)).fetchone()
    return int(row["capacity"]) if row else 3


def finalize_round1(cur):
    students = [row["student_id"] for row in cur.execute("select distinct student_id from round_applications where round = 1")]
    for student_id in students:
        if student_match(cur, student_id):
            continue
        candidates = cur.execute(
            """
            select * from round_applications
            where round = 1 and student_id = ? and status = 'preaccepted'
            order by preference_rank asc
            """,
            (student_id,),
        ).fetchall()
        chosen = None
        for candidate in candidates:
            if mentor_match_count(cur, candidate["mentor_id"]) < mentor_capacity(cur, candidate["mentor_id"]):
                chosen = candidate
                break
        if chosen:
            cur.execute(
                "insert into matches(student_id, mentor_id, round, created_at) values (?, ?, 1, ?)",
                (student_id, chosen["mentor_id"], now()),
            )
            cur.execute(
                "update round_applications set status = 'accepted' where round = 1 and student_id = ? and mentor_id = ?",
                (student_id, chosen["mentor_id"]),
            )
            cur.execute(
                "update round_applications set status = 'locked' where round = 1 and student_id = ? and mentor_id != ? and status != 'rejected'",
                (student_id, chosen["mentor_id"]),
            )
        else:
            cur.execute(
                "update round_applications set status = 'not_matched' where round = 1 and student_id = ? and status = 'preaccepted'",
                (student_id,),
            )
        cur.execute(
            "update round_applications set status = 'timeout' where round = 1 and student_id = ? and status = 'submitted'",
            (student_id,),
        )


def finalize_round2(cur):
    cur.execute("update round_applications set status = 'timeout' where round = 2 and status = 'submitted'")


def failure_reason(cur, student_id, round_number):
    statuses = [row["status"] for row in cur.execute("select status from round_applications where round = ? and student_id = ?", (round_number, student_id))]
    if not statuses:
        return "未提交申请"
    if any(status == "timeout" for status in statuses) or any(status in ("submitted", "preaccepted", "not_matched") for status in statuses):
        return "匹配超时：导师在本轮截止前没有完成接收或拒绝。"
    if all(status == "rejected" for status in statuses):
        return "需求不匹配：导师明确拒绝了申请。"
    return "本轮未成功匹配。"


def student_match(cur, student_id):
    row = cur.execute("select * from matches where student_id = ?", (student_id,)).fetchone()
    return dict(row) if row else None


def add_notification(cur, student_id, round_number, message):
    cur.execute(
        "insert into notifications(student_id, round, message, created_at) values (?, ?, ?, ?)",
        (student_id, round_number, message, now()),
    )


def close_round(cur, round_number):
    if round_number == 1:
        finalize_round1(cur)
    if round_number == 2:
        finalize_round2(cur)
    mentors = {row["id"]: dict(row) for row in cur.execute("select * from mentors")}
    students = [dict(row) for row in cur.execute("select * from students")]
    participants = students
    if round_number == 2:
        participants = [
            student
            for student in students
            if cur.execute("select 1 from round_applications where round = 2 and student_id = ?", (student["id"],)).fetchone()
        ]
    if round_number == 3:
        participants = [student for student in students if student_match(cur, student["id"])]

    for student in participants:
        match = student_match(cur, student["id"])
        mentor = mentors.get(match["mentor_id"]) if match else None
        if round_number == 1:
            message = f"第一轮匹配已经结束，你成功匹配到了{mentor['name']}导师。" if mentor else f"第一轮匹配已经结束，你未成功匹配到导师。原因：{failure_reason(cur, student['id'], 1)}你可以选择参加第二轮补录，或退出匹配。"
        elif round_number == 2:
            message = f"第二轮匹配结束，你成功匹配到了{mentor['name']}导师。" if mentor else f"第二轮匹配结束，你没有匹配成功。原因：{failure_reason(cur, student['id'], 2)}你可以选择进入管理员人工匹配，或退出匹配。"
        else:
            message = f"第三轮匹配结束，你成功匹配到了{mentor['name']}导师。" if mentor else "第三轮匹配结束，系统管理员仍需继续处理你的匹配。"
        add_notification(cur, student["id"], round_number, message)

    if round_number == 1:
        cur.execute("update round_state set round1_closed = 1, current_round = max(current_round, 2) where id = 1")
    elif round_number == 2:
        cur.execute("update round_state set round2_closed = 1, current_round = max(current_round, 3) where id = 1")
    elif round_number == 3:
        cur.execute("update round_state set round3_closed = 1 where id = 1")


def state():
    conn = db()
    data = {
        "mentors": [dict(row) for row in conn.execute("select * from mentors")],
        "students": [dict(row) for row in conn.execute("select * from students")],
        "applications": [dict(row) for row in conn.execute("select * from applications")],
        "pools": [dict(row) for row in conn.execute("select * from pools order by mentor_id, match_percent desc")],
        "decisions": [dict(row) for row in conn.execute("select * from decisions")],
        "round_state": dict(conn.execute("select * from round_state where id = 1").fetchone()),
        "round_applications": [dict(row) for row in conn.execute("select * from round_applications order by round, preference_rank, created_at")],
        "matches": [dict(row) for row in conn.execute("select * from matches")],
        "notifications": [dict(row) for row in conn.execute("select * from notifications order by id desc")],
        "mentor_settings": [dict(row) for row in conn.execute("select * from mentor_settings")],
        "student_round_choices": [dict(row) for row in conn.execute("select * from student_round_choices")],
        "feedback": [dict(row) for row in conn.execute("select * from feedback order by id desc")],
        "database": database_overview(conn),
    }
    conn.close()
    return data


def database_overview(conn):
    tables = ["mentors", "students", "applications", "pools", "decisions", "round_applications", "matches", "notifications", "mentor_settings", "student_round_choices", "feedback", "admin_actions"]
    return {
        "path": str(DB_PATH),
        "tables": [{"name": table, "rows": conn.execute(f"select count(*) from {table}").fetchone()[0]} for table in tables],
    }


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def has_access(self):
        return not ACCESS_CODE or self.headers.get("X-Demo-Access-Code") == ACCESS_CODE

    def require_access(self):
        if self.has_access():
            return True
        self.json({"ok": False, "message": "请输入正确的演示访问码。"}, status=403)
        return False

    def do_GET(self):
        if self.path in ("", "/"):
            self.path = "/index.html"
        if self.path == "/api/config":
            return self.json({"ok": True, "accessRequired": bool(ACCESS_CODE)})
        if self.path.startswith("/api/") and not self.require_access():
            return
        if self.path == "/api/state":
            return self.json(state())
        if self.path == "/api/database":
            conn = db()
            payload = database_overview(conn)
            payload["samples"] = {
                table["name"]: [dict(row) for row in conn.execute(f"select * from {table['name']} limit 5")]
                for table in payload["tables"]
            }
            conn.close()
            return self.json(payload)
        if self.path == "/api/export-db":
            conn = db()
            conn.commit()
            conn.close()
            data = DB_PATH.read_bytes()
            filename = f"abc_mentor_demo_backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}.sqlite3"
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        return super().do_GET()

    def do_POST(self):
        body = self.read_json()
        if self.path == "/api/access":
            if not ACCESS_CODE or body.get("code") == ACCESS_CODE:
                return self.json({"ok": True, "message": "访问码已通过。"})
            return self.json({"ok": False, "message": "访问码不正确。"}, status=403)
        if self.path.startswith("/api/") and not self.require_access():
            return
        conn = db()
        cur = conn.cursor()
        try:
            if self.path == "/api/apply":
                cur.execute("delete from applications where student_id = ?", (body["studentId"],))
                cur.execute("insert into applications values (?, ?, 'pending', ?)", (body["studentId"], body["mentorId"], now()))
                cur.execute("delete from decisions where student_id = ?", (body["studentId"],))
                cur.execute("delete from pools where student_id = ?", (body["studentId"],))
                conn.commit()
                run_matching()
                return self.json({"ok": True, "message": "申请已提交，系统已重新匹配。"})

            if self.path == "/api/round1/apply":
                rs = round_state(cur)
                if rs["round1_closed"]:
                    return self.json({"ok": False, "message": "第一轮申请已经结束。"}, status=400)
                if student_match(cur, body["studentId"]):
                    return self.json({"ok": False, "message": "你已经匹配成功，不能重复申请。"}, status=400)
                preferences = [mentor_id for mentor_id in body.get("preferences", []) if mentor_id]
                seen = set()
                preferences = [mentor_id for mentor_id in preferences if not (mentor_id in seen or seen.add(mentor_id))]
                if not preferences:
                    return self.json({"ok": False, "message": "请至少选择一位志愿导师。"}, status=400)
                if len(preferences) > 3:
                    return self.json({"ok": False, "message": "第一轮最多提交三位志愿导师。"}, status=400)
                existing = cur.execute("select 1 from round_applications where round = 1 and student_id = ?", (body["studentId"],)).fetchone()
                if existing:
                    return self.json({"ok": False, "message": "第一轮志愿已提交，不能更改。"}, status=400)
                for rank, mentor_id in enumerate(preferences, start=1):
                    cur.execute(
                        "insert into round_applications(round, student_id, mentor_id, preference_rank, message, status, created_at) values (1, ?, ?, ?, ?, 'submitted', ?)",
                        (body["studentId"], mentor_id, rank, body.get("message", ""), now()),
                    )
                conn.commit()
                return self.json({"ok": True, "message": "第一轮志愿已提交。"})

            if self.path == "/api/round2/apply":
                rs = round_state(cur)
                if not rs["round1_closed"] or rs["round2_closed"]:
                    return self.json({"ok": False, "message": "当前不能提交第二轮申请。"}, status=400)
                if student_match(cur, body["studentId"]):
                    return self.json({"ok": False, "message": "你已经匹配成功，不能参加补录。"}, status=400)
                choice = cur.execute("select choice from student_round_choices where student_id = ? and round = 2", (body["studentId"],)).fetchone()
                if choice and choice["choice"] == "exit":
                    return self.json({"ok": False, "message": "你已选择退出匹配，不能提交第二轮申请。"}, status=400)
                cur.execute("delete from round_applications where round = 2 and student_id = ?", (body["studentId"],))
                cur.execute(
                    "insert into round_applications(round, student_id, mentor_id, preference_rank, message, status, created_at) values (2, ?, ?, 1, ?, 'submitted', ?)",
                    (body["studentId"], body["mentorId"], body.get("message", ""), now()),
                )
                conn.commit()
                return self.json({"ok": True, "message": "第二轮补录申请已提交。"})

            if self.path == "/api/student/round-choice":
                student_id = body["studentId"]
                round_number = int(body["round"])
                choice = body["choice"]
                if choice not in ("continue", "exit"):
                    return self.json({"ok": False, "message": "无效选择。"}, status=400)
                if student_match(cur, student_id):
                    return self.json({"ok": False, "message": "你已经匹配成功，不需要选择下一步。"}, status=400)
                cur.execute(
                    "insert into student_round_choices(student_id, round, choice, created_at) values (?, ?, ?, ?) on conflict(student_id, round) do update set choice = excluded.choice, created_at = excluded.created_at",
                    (student_id, round_number, choice, now()),
                )
                conn.commit()
                return self.json({"ok": True, "message": "选择已保存。"})

            if self.path == "/api/mentor/select":
                round_number = int(body.get("round", 1))
                student_id = body["studentId"]
                mentor_id = body["mentorId"]
                app = cur.execute(
                    "select * from round_applications where round = ? and mentor_id = ? and student_id = ?",
                    (round_number, mentor_id, student_id),
                ).fetchone()
                if not app:
                    return self.json({"ok": False, "message": "未找到该学员申请。"}, status=404)
                if app["status"] == "rejected":
                    return self.json({"ok": False, "message": "该申请已被拒绝，不能再次选择。"}, status=400)
                if round_number == 1:
                    rs = round_state(cur)
                    if rs["round1_closed"]:
                        return self.json({"ok": False, "message": "第一轮已经结束，不能继续反选。"}, status=400)
                    if app["status"] == "preaccepted":
                        return self.json({"ok": True, "message": "该学员已在你的预匹配名单中。"})
                    if mentor_preaccepted_count(cur, mentor_id) + mentor_match_count(cur, mentor_id) >= mentor_capacity(cur, mentor_id):
                        return self.json({"ok": False, "message": "该导师名额已满。"}, status=400)
                    cur.execute(
                        "update round_applications set status = 'preaccepted' where round = 1 and mentor_id = ? and student_id = ?",
                        (mentor_id, student_id),
                    )
                    conn.commit()
                    return self.json({"ok": True, "message": "已加入预匹配，第一轮结束时统一结算。"})
                if mentor_match_count(cur, mentor_id) >= mentor_capacity(cur, mentor_id):
                    return self.json({"ok": False, "message": "该导师名额已满。"}, status=400)
                existing_match = student_match(cur, student_id)
                if existing_match:
                    return self.json({"ok": False, "message": "该学员已经被其他导师匹配。"}, status=400)
                cur.execute("insert into matches(student_id, mentor_id, round, created_at) values (?, ?, ?, ?)", (student_id, mentor_id, round_number, now()))
                cur.execute("update round_applications set status = 'accepted' where round = ? and mentor_id = ? and student_id = ?", (round_number, mentor_id, student_id))
                conn.commit()
                return self.json({"ok": True, "message": "已反选该学员。"})

            if self.path == "/api/mentor/capacity":
                mentor_id = body["mentorId"]
                capacity = max(1, min(20, int(body["capacity"])))
                if mentor_match_count(cur, mentor_id) + mentor_preaccepted_count(cur, mentor_id) > capacity:
                    return self.json({"ok": False, "message": "当前已匹配或预匹配人数超过该上限，不能设置为这个数字。"}, status=400)
                cur.execute(
                    "insert into mentor_settings(mentor_id, capacity) values (?, ?) on conflict(mentor_id) do update set capacity = excluded.capacity",
                    (mentor_id, capacity),
                )
                conn.commit()
                return self.json({"ok": True, "message": "名额上限已更新。"})

            if self.path == "/api/mentor/reject":
                cur.execute(
                    "update round_applications set status = 'rejected' where round = ? and mentor_id = ? and student_id = ? and status in ('submitted', 'preaccepted')",
                    (int(body.get("round", 2)), body["mentorId"], body["studentId"]),
                )
                conn.commit()
                return self.json({"ok": True, "message": "已拒绝该申请。"})

            if self.path == "/api/admin/end-round":
                close_round(cur, int(body["round"]))
                conn.commit()
                return self.json({"ok": True, "message": f"第 {body['round']} 轮匹配已结束，通知已生成。"})

            if self.path == "/api/admin/reopen-round1":
                cur.execute("delete from matches where round in (1, 2, 3)")
                cur.execute("delete from round_applications where round in (2, 3)")
                cur.execute(
                    "update round_applications set status = 'submitted' where round = 1 and status in ('accepted', 'locked', 'timeout', 'not_matched')"
                )
                cur.execute("delete from notifications where round in (1, 2, 3)")
                cur.execute("delete from student_round_choices where round in (2, 3)")
                cur.execute("update round_state set current_round = 1, round1_closed = 0, round2_closed = 0, round3_closed = 0 where id = 1")
                cur.execute("insert into admin_actions(action, detail, created_at) values (?, ?, ?)", ("reopen_round1", "{}", now()))
                conn.commit()
                return self.json({"ok": True, "message": "已撤回第一轮结算，回到第一轮测试状态。"})

            if self.path == "/api/admin/manual-match":
                student_id = body["studentId"]
                mentor_id = body["mentorId"]
                rs = round_state(cur)
                if not rs["round2_closed"] or rs["round3_closed"]:
                    return self.json({"ok": False, "message": "第三轮人工匹配只能在第二轮结束后进行。"}, status=400)
                if student_match(cur, student_id):
                    return self.json({"ok": False, "message": "该学员已经匹配成功。"}, status=400)
                choice = cur.execute("select choice from student_round_choices where student_id = ? and round = 3", (student_id,)).fetchone()
                if not choice or choice["choice"] != "continue":
                    return self.json({"ok": False, "message": "该学员尚未选择进入管理员人工匹配。"}, status=400)
                if mentor_match_count(cur, mentor_id) >= mentor_capacity(cur, mentor_id):
                    return self.json({"ok": False, "message": "该导师名额已满。"}, status=400)
                cur.execute("insert into matches(student_id, mentor_id, round, created_at) values (?, ?, 3, ?)", (student_id, mentor_id, now()))
                cur.execute(
                    "insert or ignore into round_applications(round, student_id, mentor_id, preference_rank, message, status, created_at) values (3, ?, ?, 1, '管理员人工匹配', 'accepted', ?)",
                    (student_id, mentor_id, now()),
                )
                cur.execute("update round_applications set status = 'accepted' where round = 3 and student_id = ? and mentor_id = ?", (student_id, mentor_id))
                conn.commit()
                return self.json({"ok": True, "message": "已完成管理员人工匹配。"})

            if self.path == "/api/decision":
                accepted = cur.execute(
                    "select count(*) from decisions where mentor_id = ? and decision = 'accepted'",
                    (body["mentorId"],),
                ).fetchone()[0]
                existing = cur.execute(
                    "select decision from decisions where mentor_id = ? and student_id = ?",
                    (body["mentorId"], body["studentId"]),
                ).fetchone()
                if body["decision"] == "accepted" and accepted >= 3 and (not existing or existing["decision"] != "accepted"):
                    return self.json({"ok": False, "message": "该导师已接收 3 位学员。"}, status=400)
                if body["decision"] == "rejected":
                    cur.execute("delete from decisions where mentor_id = ? and student_id = ?", (body["mentorId"], body["studentId"]))
                    cur.execute("delete from pools where mentor_id = ? and student_id = ?", (body["mentorId"], body["studentId"]))
                    cur.execute("delete from applications where mentor_id = ? and student_id = ?", (body["mentorId"], body["studentId"]))
                    conn.commit()
                    return self.json({"ok": True, "message": "已拒绝申请，学员状态已回到未申请。"})
                cur.execute(
                    "insert or replace into decisions values (?, ?, ?, ?)",
                    (body["mentorId"], body["studentId"], body["decision"], now()),
                )
                sync_statuses(cur)
                conn.commit()
                return self.json({"ok": True, "message": "导师选择已保存。"})

            if self.path == "/api/rerun":
                conn.commit()
                run_matching()
                return self.json({"ok": True, "message": "匹配已重新计算。"})

            if self.path == "/api/import-csv":
                with (INPUT_DIR / "mentors.csv").open(newline="", encoding="utf-8") as file:
                    for index, row in enumerate(csv.DictReader(file), start=1):
                        cur.execute(
                            "insert or replace into mentors values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                            (f"m{index}", row["name"], row["school"], row["industry"], row["title"], row["interests"], row["projects"], row["topics"], row["message"]),
                        )
                with (INPUT_DIR / "students.csv").open(newline="", encoding="utf-8") as file:
                    for index, row in enumerate(csv.DictReader(file), start=1):
                        cur.execute(
                            "insert or replace into students values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                            (f"s{index}", row["name"], row["school"], row["major"], row["interests"], row["pre_agreed_mentor"], row["intended_mentor"], row["experience"], row["message"]),
                        )
                cur.execute("delete from pools where is_manual = 0")
                conn.commit()
                run_matching()
                return self.json({"ok": True, "message": "CSV 问卷数据已同步，当前申请状态已保留。"})

            if self.path == "/api/admin/assign":
                mentor = cur.execute("select * from mentors where id = ?", (body["mentorId"],)).fetchone()
                student = cur.execute("select * from students where id = ?", (body["studentId"],)).fetchone()
                percent = score_match(dict(student), dict(mentor))
                cur.execute("delete from applications where student_id = ?", (body["studentId"],))
                cur.execute("insert into applications values (?, ?, 'pending', ?)", (body["studentId"], body["mentorId"], now()))
                cur.execute(
                    "insert or replace into pools values (?, ?, ?, '管理员手动调整', 1)",
                    (body["mentorId"], body["studentId"], percent),
                )
                cur.execute("delete from decisions where student_id = ?", (body["studentId"],))
                cur.execute("insert into admin_actions(action, detail, created_at) values (?, ?, ?)", ("assign", json.dumps(body, ensure_ascii=False), now()))
                sync_statuses(cur)
                conn.commit()
                return self.json({"ok": True, "message": "已放入导师选择池。"})

            if self.path == "/api/admin/unpair":
                mentor = cur.execute("select name from mentors where id = ?", (body["mentorId"],)).fetchone()
                match = cur.execute(
                    "select * from matches where mentor_id = ? and student_id = ?",
                    (body["mentorId"], body["studentId"]),
                ).fetchone()
                cur.execute(
                    "delete from matches where mentor_id = ? and student_id = ?",
                    (body["mentorId"], body["studentId"]),
                )
                cur.execute(
                    "update round_applications set status = 'submitted' where mentor_id = ? and student_id = ? and status = 'accepted'",
                    (body["mentorId"], body["studentId"]),
                )
                if match and int(match["round"]) == 1:
                    cur.execute(
                        "update round_applications set status = 'submitted' where round = 1 and student_id = ? and status = 'locked'",
                        (body["studentId"],),
                    )
                cur.execute(
                    "delete from decisions where mentor_id = ? and student_id = ?",
                    (body["mentorId"], body["studentId"]),
                )
                if mentor:
                    cur.execute(
                        "delete from notifications where student_id = ? and message like ?",
                        (body["studentId"], f"%成功匹配到了{mentor['name']}导师%"),
                    )
                cur.execute("insert into admin_actions(action, detail, created_at) values (?, ?, ?)", ("unpair", json.dumps(body, ensure_ascii=False), now()))
                sync_statuses(cur)
                conn.commit()
                return self.json({"ok": True, "message": "已解除接收状态，学员回到当前匹配流程。"})

            if self.path == "/api/admin/cancel-application":
                decision = cur.execute(
                    "select decision from decisions where mentor_id = ? and student_id = ?",
                    (body["mentorId"], body["studentId"]),
                ).fetchone()
                if decision:
                    return self.json({"ok": False, "message": "导师已处理该申请，不能撤销。"}, status=400)
                cur.execute("delete from pools where mentor_id = ? and student_id = ?", (body["mentorId"], body["studentId"]))
                cur.execute("delete from applications where mentor_id = ? and student_id = ?", (body["mentorId"], body["studentId"]))
                cur.execute("insert into admin_actions(action, detail, created_at) values (?, ?, ?)", ("cancel_application", json.dumps(body, ensure_ascii=False), now()))
                sync_statuses(cur)
                conn.commit()
                return self.json({"ok": True, "message": "已撤销申请，学员状态已回到未申请。"})

            if self.path == "/api/feedback":
                thread_id = body.get("threadId")
                cur.execute(
                    "insert into feedback(thread_id, from_role, from_name, to_role, content, created_at) values (?, ?, ?, ?, ?, ?)",
                    (thread_id, body["fromRole"], body["fromName"], body.get("toRole", "admin"), body["content"], now()),
                )
                feedback_id = cur.lastrowid
                if thread_id is None:
                    cur.execute("update feedback set thread_id = ? where id = ?", (feedback_id, feedback_id))
                conn.commit()
                return self.json({"ok": True, "message": "反馈已发送。"})

            return self.json({"ok": False, "message": "未知接口。"}, status=404)
        finally:
            conn.close()

    def read_json(self):
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length) or "{}")

    def json(self, payload, status=200):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    init_db()
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "4173"))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"ABC mentor demo running at http://{host}:{port}/")
    server.serve_forever()
