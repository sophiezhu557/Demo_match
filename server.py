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
        """
    )

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


def state():
    conn = db()
    data = {
        "mentors": [dict(row) for row in conn.execute("select * from mentors")],
        "students": [dict(row) for row in conn.execute("select * from students")],
        "applications": [dict(row) for row in conn.execute("select * from applications")],
        "pools": [dict(row) for row in conn.execute("select * from pools order by mentor_id, match_percent desc")],
        "decisions": [dict(row) for row in conn.execute("select * from decisions")],
        "feedback": [dict(row) for row in conn.execute("select * from feedback order by id desc")],
        "database": database_overview(conn),
    }
    conn.close()
    return data


def database_overview(conn):
    tables = ["mentors", "students", "applications", "pools", "decisions", "feedback", "admin_actions"]
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
                cur.execute(
                    "delete from decisions where mentor_id = ? and student_id = ?",
                    (body["mentorId"], body["studentId"]),
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
