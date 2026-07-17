const state = {
  mentors: [],
  students: [],
  applications: [],
  pools: [],
  decisions: [],
  round_state: { current_round: 1, round1_closed: 0, round2_closed: 0, round3_closed: 0 },
  round_applications: [],
  matches: [],
  notifications: [],
  mentor_settings: [],
  student_round_choices: [],
  feedback: [],
  database: {},
  currentRole: "",
  currentStudentId: "",
  currentMentorId: "",
  pendingAccountRole: "",
  pendingSwitchMentorId: "",
  showStudentScores: false,
  showMentorScores: false,
  adminView: "matches",
  adminSearch: "",
  adminStudentStatus: "all",
  adminMentorPanels: {},
  mentorSort: "preference",
  accessRequired: false
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const accessStorageKey = "abcMentorDemoAccessCode";

const roleNames = {
  student: "学员",
  mentor: "导师",
  admin: "管理员"
};

function byId(list, id) {
  return list.find((item) => item.id === id);
}

function tags(value) {
  return String(value || "").split(/[;；、,，]+/).map((item) => item.trim()).filter(Boolean);
}

function unique(values) {
  return [...new Set(values.flat().filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
}

function pill(text) {
  return `<span class="pill">${escapeHtml(text)}</span>`;
}

function percent(value) {
  return `${Number(value || 0)}%`;
}

function tokenize(value) {
  return String(value || "")
    .toLowerCase()
    .split(/[\s,，、。；;：:]+/)
    .filter(Boolean);
}

function estimatedMatchPercent(student, mentor) {
  const sharedInterests = tags(student.interests).filter((item) => tags(mentor.interests).includes(item)).length;
  const interestScore = Math.min(sharedInterests * 20, 40);
  const studentWords = tokenize(`${student.major} ${student.experience} ${student.message} ${student.interests}`);
  const mentorWords = tokenize(`${mentor.industry} ${mentor.title} ${mentor.projects} ${mentor.topics} ${mentor.message} ${mentor.interests}`);
  const overlap = studentWords.filter((word) => mentorWords.some((target) => target.includes(word) || word.includes(target)));
  const textScore = Math.min(overlap.length * 6, 45);
  const intentionScore = student.intended_mentor === mentor.name ? 10 : 0;
  const preAgreedScore = student.pre_agreed_mentor === mentor.name ? 20 : 0;
  return Math.min(100, interestScore + textScore + intentionScore + preAgreedScore);
}

function matchPercentFor(student, mentor) {
  const poolMatch = state.pools.find((item) => item.mentor_id === mentor.id && item.student_id === student.id);
  return poolMatch?.match_percent ?? estimatedMatchPercent(student, mentor);
}

function statusLabel(status) {
  const map = {
    pending: ["已提交", "amber"],
    in_pool: ["已提交", "green"],
    not_matched: ["系统未匹配", "red"],
    accepted: ["被接收", "green"],
    rejected: ["被拒绝", "red"]
  };
  return map[status] || ["未知", ""];
}

function progressLabel(status) {
  if (status === "accepted") return ["被接收", "green"];
  if (status === "rejected") return ["被拒绝", "red"];
  if (status) return ["已提交", "green"];
  return ["未提交", "amber"];
}

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  const accessCode = window.sessionStorage.getItem(accessStorageKey);
  if (accessCode) {
    headers["X-Demo-Access-Code"] = accessCode;
  }
  const response = await fetch(path, {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) {
    throw new Error(data.message || "操作失败");
  }
  return data;
}

function downloadBlob(blob, filename) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
}

function exportTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

async function exportDatabaseBackup() {
  try {
    const headers = {};
    const accessCode = window.sessionStorage.getItem(accessStorageKey);
    if (accessCode) {
      headers["X-Demo-Access-Code"] = accessCode;
    }
    const response = await fetch("/api/export-db", { headers });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.message || "数据库导出失败");
    }
    const blob = await response.blob();
    downloadBlob(blob, `abc-mentor-db-${exportTimestamp()}.sqlite3`);
    showToast("数据库备份已导出。");
  } catch (error) {
    showToast(error.message, "error");
  }
}

function showAccessScreen() {
  $("#access-screen").classList.remove("hidden");
  $("#login-screen").classList.add("hidden");
  $("#account-screen").classList.add("hidden");
  $$(".app-shell").forEach((item) => item.classList.add("hidden"));
}

function showLoginScreen() {
  $("#access-screen").classList.add("hidden");
  $("#login-screen").classList.remove("hidden");
}

async function loadConfig() {
  const config = await api("/api/config");
  state.accessRequired = Boolean(config.accessRequired);
}

async function loadState() {
  const data = await api("/api/state");
  Object.assign(state, data);
  populateSelects();
  renderAll();
}

function showToast(message, tone = "success") {
  const toast = $("#toast");
  toast.textContent = message;
  toast.className = `toast show ${tone}`;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 2400);
}

async function mutate(path, body, successMessage) {
  try {
    const result = await api(path, { method: "POST", body });
    await loadState();
    showToast(successMessage || result.message || "操作成功");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function submitAccessCode() {
  const code = $("#accessCodeInput").value.trim();
  if (!code) {
    showToast("请输入访问码。", "error");
    return;
  }
  window.sessionStorage.setItem(accessStorageKey, code);
  try {
    await api("/api/access", { method: "POST", body: { code } });
    await loadState();
    showLoginScreen();
    showToast("访问码已通过。");
  } catch (error) {
    window.sessionStorage.removeItem(accessStorageKey);
    showToast(error.message, "error");
  }
}

function populateSelects() {
  $("#industryFilter").innerHTML = `<option value="">全部行业</option>${unique(state.mentors.map((mentor) => [mentor.industry])).map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join("")}`;
  $("#interestFilter").innerHTML = `<option value="">全部方向</option>${unique(state.mentors.map((mentor) => tags(mentor.interests))).map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join("")}`;
}

function showAccountPicker(role) {
  state.currentRole = "";
  $("#login-screen").classList.add("hidden");
  $("#account-screen").classList.remove("hidden");
  const isStudent = role === "student";
  const people = isStudent ? state.students : state.mentors;
  state.pendingAccountRole = role;
  $("#accountTitle").textContent = isStudent ? "学员登录" : "导师登录";
  $("#accountPrompt").textContent = isStudent ? "请选择具体是哪位学员" : "请选择具体是哪位导师";
  $("#accountSelectLabel").textContent = isStudent ? "学员" : "导师";
  $("#accountSelect").innerHTML = people.map((person) => {
    const subtitle = isStudent ? `${person.school} · ${person.major}` : `${person.school} · ${person.industry} · ${person.title}`;
    return `<option value="${person.id}">${escapeHtml(person.name)}｜${escapeHtml(subtitle)}</option>`;
  }).join("");
}

function enterSelectedAccount() {
  const accountId = $("#accountSelect").value;
  if (!accountId || !state.pendingAccountRole) {
    showToast("请选择账号", "error");
    return;
  }
  if (state.pendingAccountRole === "student") {
    state.currentStudentId = accountId;
  } else {
    state.currentMentorId = accountId;
  }
  setRole(state.pendingAccountRole);
}

function setRole(role) {
  state.currentRole = role;
  $("#access-screen").classList.add("hidden");
  $("#login-screen").classList.add("hidden");
  $("#account-screen").classList.add("hidden");
  $$(".app-shell").forEach((item) => item.classList.remove("hidden"));
  $$(".view").forEach((view) => view.classList.toggle("active", view.id === `${role}-view`));
  $("#loginRole").textContent = roleNames[role];
  renderAll();
}

function logout() {
  state.currentRole = "";
  state.currentStudentId = "";
  state.currentMentorId = "";
  state.pendingAccountRole = "";
  $$(".app-shell").forEach((item) => item.classList.add("hidden"));
  $$(".view").forEach((view) => view.classList.remove("active"));
  $("#access-screen").classList.add("hidden");
  $("#account-screen").classList.add("hidden");
  $("#login-screen").classList.remove("hidden");
}

function backToRolePicker() {
  state.pendingAccountRole = "";
  $("#account-screen").classList.add("hidden");
  $("#login-screen").classList.remove("hidden");
}

function currentActor() {
  if (state.currentRole === "student") {
    const student = byId(state.students, state.currentStudentId);
    return { role: "student", name: student?.name || "学员" };
  }
  if (state.currentRole === "mentor") {
    const mentor = byId(state.mentors, state.currentMentorId);
    return { role: "mentor", name: mentor?.name || "导师" };
  }
  if (!state.currentRole) {
    return { role: "", name: "未登录" };
  }
  return { role: "admin", name: "管理员" };
}

function applicationForStudent(studentId) {
  return state.applications.find((app) => app.student_id === studentId);
}

function poolForMentor(mentorId) {
  return state.pools.filter((item) => item.mentor_id === mentorId);
}

function decisionFor(mentorId, studentId) {
  return state.decisions.find((item) => item.mentor_id === mentorId && item.student_id === studentId);
}

function acceptedApplications() {
  return state.decisions
    .filter((item) => item.decision === "accepted")
    .map((item) => ({
      decision: item,
      student: byId(state.students, item.student_id),
      mentor: byId(state.mentors, item.mentor_id)
    }))
    .filter((item) => item.student && item.mentor);
}

function matchForStudent(studentId) {
  return state.matches.find((item) => item.student_id === studentId);
}

function mentorMatches(mentorId) {
  return state.matches.filter((item) => item.mentor_id === mentorId);
}

function mentorCapacity(mentorId) {
  const setting = state.mentor_settings.find((item) => item.mentor_id === mentorId);
  return Number(setting?.capacity || 3);
}

function roundApplicationsForStudent(studentId, round = null) {
  return state.round_applications.filter((item) => item.student_id === studentId && (!round || Number(item.round) === round));
}

function roundApplicationsForMentor(mentorId, round = null) {
  return state.round_applications.filter((item) => item.mentor_id === mentorId && (!round || Number(item.round) === round));
}

function latestNotifications(studentId) {
  return state.notifications.filter((item) => item.student_id === studentId).slice(0, 4);
}

function roundChoiceForStudent(studentId, round) {
  return state.student_round_choices.find((item) => item.student_id === studentId && Number(item.round) === Number(round))?.choice || "";
}

function preferenceLabel(rank) {
  return rank === 1 ? "第一志愿" : rank === 2 ? "第二志愿" : rank === 3 ? "第三志愿" : "补录申请";
}

function roundLabel(round) {
  return round === 1 ? "第一轮" : round === 2 ? "第二轮" : "第三轮";
}

function mentorCapacityLeft(mentorId) {
  return Math.max(0, mentorCapacity(mentorId) - mentorMatches(mentorId).length);
}

function mentorPreacceptedCount(mentorId) {
  return roundApplicationsForMentor(mentorId, 1).filter((app) => app.status === "preaccepted").length;
}

function isMentorFull(mentorId, round = null) {
  const used = Number(round) === 1 ? mentorPreacceptedCount(mentorId) + mentorMatches(mentorId).length : mentorMatches(mentorId).length;
  return used >= mentorCapacity(mentorId);
}

function parseCreatedAt(value) {
  return new Date(String(value || "").replace(" ", "T")).getTime();
}

function isTimedOut(app) {
  return app.status === "timeout";
}

function applicationStatusInfo(student) {
  const match = matchForStudent(student.id);
  if (match) return { key: "accepted", label: "已接受", color: "green" };
  if (roundChoiceForStudent(student.id, 2) === "exit" || roundChoiceForStudent(student.id, 3) === "exit") return { key: "exit", label: "已退出", color: "red" };
  const apps = roundApplicationsForStudent(student.id);
  if (!apps.length) return { key: "none", label: "未提交", color: "amber" };
  if (apps.some(isTimedOut)) return { key: "timeout", label: "超时", color: "red" };
  if (apps.every((app) => app.status === "rejected")) return { key: "rejected", label: "已拒绝", color: "red" };
  if (apps.some((app) => app.status === "preaccepted")) return { key: "preaccepted", label: "预匹配中", color: "amber" };
  const activeApps = apps.filter((app) => app.status !== "rejected");
  if (activeApps.length && activeApps.every((app) => isMentorFull(app.mentor_id, app.round))) return { key: "full", label: "满额", color: "red" };
  return { key: "submitted", label: "已提交", color: "green" };
}

function roundFailureReason(studentId, round) {
  const apps = roundApplicationsForStudent(studentId, round);
  if (!apps.length) return "未提交申请";
  if (apps.some((app) => app.status === "timeout") || apps.some((app) => ["submitted", "preaccepted", "not_matched"].includes(app.status))) {
    return "匹配超时：导师在本轮截止前没有完成接收或拒绝。";
  }
  if (apps.every((app) => app.status === "rejected")) {
    return "需求不匹配：导师明确拒绝了申请。";
  }
  return "本轮未成功匹配。";
}

function roundFailed(studentId, round) {
  return Number(round) === 1
    ? state.round_state.round1_closed && !matchForStudent(studentId)
    : state.round_state.round2_closed && !matchForStudent(studentId) && roundApplicationsForStudent(studentId, 2).length > 0;
}

function roundApplicationStatusLabel(status) {
  const map = {
    submitted: "已提交",
    preaccepted: "预匹配中",
    accepted: "最终匹配成功",
    locked: "已与其他导师匹配",
    rejected: "已拒绝",
    timeout: "超时",
    not_matched: "未匹配"
  };
  return map[status] || status || "未知";
}

function renderStudentView() {
  const student = byId(state.students, state.currentStudentId);
  if (!student) return;
  const match = matchForStudent(student.id);
  const matchedMentor = match ? byId(state.mentors, match.mentor_id) : null;
  const round1Apps = roundApplicationsForStudent(student.id, 1);
  const round2Apps = roundApplicationsForStudent(student.id, 2).filter((app) => app.status !== "rejected");
  const currentRound = Number(state.round_state.current_round || 1);
  const round2Choice = roundChoiceForStudent(student.id, 2);
  const round3Choice = roundChoiceForStudent(student.id, 3);
  const canRound1Apply = !state.round_state.round1_closed && !round1Apps.length && !match;
  const canRound2Apply = state.round_state.round1_closed && !state.round_state.round2_closed && !match && round2Choice === "continue";
  const round1NeedsChoice = roundFailed(student.id, 1) && !round2Choice && !state.round_state.round2_closed;
  const round2NeedsChoice = roundFailed(student.id, 2) && !round3Choice;
  const notifications = latestNotifications(student.id);

  $("#studentProgress").innerHTML = `
    <div class="progress-item">
      <strong>${match ? "匹配状态" : "当前阶段"}</strong>
      <span>${match ? "已完成匹配" : roundLabel(currentRound)}</span>
    </div>
    <div class="progress-item">
      <strong>匹配结果</strong>
      <span class="badge ${match ? "green" : "amber"}">${match ? `已匹配 ${escapeHtml(matchedMentor?.name || "")}` : "暂未匹配"}</span>
    </div>
    <div class="progress-item">
      <strong>${match ? "说明" : "轮次规则"}</strong>
      <span>${match ? "你的匹配流程已经结束。" : currentRound === 1 ? "第一轮最多提交 3 个志愿，提交后不可修改" : currentRound === 2 ? "第二轮只能定向申请 1 位导师" : "第三轮由管理员人工匹配"}</span>
      <button id="toggleStudentScores" class="secondary score-toggle">${state.showStudentScores ? "隐藏匹配度（%）" : "显示匹配度（%）"}</button>
    </div>
  `;

  $("#studentQuestionnaire").innerHTML = `
    <h3>我的问卷</h3>
    <div class="meta">院校：${escapeHtml(student.school)}</div>
    <div class="meta">专业：${escapeHtml(student.major)}</div>
    <div class="pill-row">${tags(student.interests).map(pill).join("")}</div>
    <div class="meta">提前约定：${escapeHtml(student.pre_agreed_mentor || "无")}</div>
    <div class="meta">意向导师：${escapeHtml(student.intended_mentor || "无")}</div>
    <div class="meta">过往经历：${escapeHtml(student.experience)}</div>
    <div class="meta">公开展示：当前 demo 默认展示学员愿意公开的问卷部分。</div>
  `;

  const industry = $("#industryFilter").value;
  const interest = $("#interestFilter").value;
  const query = $("#mentorSearch").value.trim().toLowerCase();
  const filtered = state.mentors.filter((mentor) => {
    const haystack = `${mentor.name} ${mentor.school} ${mentor.industry} ${mentor.title} ${mentor.projects} ${mentor.topics} ${mentor.message}`.toLowerCase();
    return (!industry || mentor.industry === industry) && (!interest || tags(mentor.interests).includes(interest)) && (!query || haystack.includes(query));
  }).sort((a, b) => matchPercentFor(student, b) - matchPercentFor(student, a));

  const mentorOptions = `<option value="">不选择</option>${filtered.map((mentor) => `<option value="${mentor.id}">${escapeHtml(mentor.name)}｜${escapeHtml(mentor.industry)}｜${percent(matchPercentFor(student, mentor))}</option>`).join("")}`;
  const round1Submitted = round1Apps.length ? `
    <div class="panel round-application-panel">
      <h3>第一轮志愿已提交</h3>
      ${round1Apps.sort((a, b) => a.preference_rank - b.preference_rank).map((app) => `<div class="mini-row"><span>${preferenceLabel(app.preference_rank)}</span><strong>${escapeHtml(byId(state.mentors, app.mentor_id)?.name || "")}</strong></div>`).join("")}
      <div class="meta">补充信息：${escapeHtml(round1Apps[0]?.message || "无")}</div>
    </div>
  ` : "";
  const round2Submitted = round2Apps.length ? `
    <div class="panel round-application-panel">
      <h3>第二轮补录申请已提交</h3>
      <div class="mini-row"><span>定向导师</span><strong>${escapeHtml(byId(state.mentors, round2Apps[0].mentor_id)?.name || "")}</strong></div>
      <div class="meta">补充信息：${escapeHtml(round2Apps[0]?.message || "无")}</div>
    </div>
  ` : "";
  const round1ChoicePanel = round1NeedsChoice ? `
    <div class="panel round-application-panel">
      <h3>第一轮未匹配成功</h3>
      <p class="meta">原因：${escapeHtml(roundFailureReason(student.id, 1))}</p>
      <div class="actions">
        <button data-round-choice="2|continue">参加第二轮补录</button>
        <button class="secondary" data-round-choice="2|exit">退出匹配</button>
      </div>
    </div>
  ` : "";
  const round2ChoicePanel = round2NeedsChoice ? `
    <div class="panel round-application-panel">
      <h3>第二轮未匹配成功</h3>
      <p class="meta">原因：${escapeHtml(roundFailureReason(student.id, 2))}</p>
      <div class="actions">
        <button data-round-choice="3|continue">进入管理员人工匹配</button>
        <button class="secondary" data-round-choice="3|exit">退出匹配</button>
      </div>
    </div>
  ` : "";
  const exitPanel = (round2Choice === "exit" || round3Choice === "exit") && !match ? `
    <div class="panel round-application-panel">
      <h3>已退出匹配</h3>
      <p class="meta">你已选择退出后续匹配流程。</p>
    </div>
  ` : "";
  const waitForManualPanel = state.round_state.round2_closed && !match && round3Choice === "continue" ? `<div class="empty">等待管理员第三轮人工匹配。</div>` : "";
  const applicationPanel = match ? `
    <div class="panel round-application-panel">
      <h3>匹配成功</h3>
      <p>你已成功匹配到 ${escapeHtml(matchedMentor?.name || "")} 导师。</p>
    </div>
  ` : canRound1Apply ? `
    <div class="panel round-application-panel">
      <h3>第一轮导师申请</h3>
      <label>第一志愿<select id="round1Pref1">${mentorOptions}</select></label>
      <label>第二志愿<select id="round1Pref2">${mentorOptions}</select></label>
      <label>第三志愿<select id="round1Pref3">${mentorOptions}</select></label>
      <label>补充信息 / 简历<textarea id="round1Message" rows="4" placeholder="可选：给导师补充说明你的经历、兴趣或希望获得的帮助"></textarea></label>
      <button id="submitRound1">提交第一轮志愿</button>
    </div>
  ` : canRound2Apply && !round2Apps.length ? `
    <div class="panel round-application-panel">
      <h3>第二轮补录申请</h3>
      <p class="meta">本轮只能定向申请一位尚未招满的导师。</p>
      <label>补录导师<select id="round2Mentor"><option value="">请选择导师</option>${filtered.filter((mentor) => mentorCapacityLeft(mentor.id) > 0).map((mentor) => `<option value="${mentor.id}">${escapeHtml(mentor.name)}｜剩余 ${mentorCapacityLeft(mentor.id)} 个名额</option>`).join("")}</select></label>
      <label>补充信息 / 简历<textarea id="round2Message" rows="4" placeholder="可选：给导师补充说明"></textarea></label>
      <button id="submitRound2">提交第二轮申请</button>
    </div>
  ` : `${round1ChoicePanel}${round2ChoicePanel}${exitPanel}${round1Submitted}${round2Submitted}${waitForManualPanel}`;

  $("#mentorCards").innerHTML = `
    ${notifications.length ? `<section class="panel notification-panel"><h3>系统通知</h3>${notifications.map((item) => `<div class="message"><p>${escapeHtml(item.message)}</p><div class="meta">${escapeHtml(item.created_at)}</div></div>`).join("")}</section>` : ""}
    ${applicationPanel}
    <h3 class="subhead">导师公开资料</h3>
    ${filtered.map((mentor) => {
      const matchValue = matchPercentFor(student, mentor);
      return `
        <article class="card">
          <header>
            <div>
              <h3>${escapeHtml(mentor.name)}</h3>
              <div class="meta">${escapeHtml(mentor.school)} · ${escapeHtml(mentor.industry)} · ${escapeHtml(mentor.title)}</div>
            </div>
            ${state.showStudentScores ? `<span class="badge">${percent(matchValue)}</span>` : ""}
          </header>
          <div class="pill-row">${tags(mentor.interests).map(pill).join("")}</div>
          <p>${escapeHtml(mentor.projects)}</p>
          <div class="meta">关注话题：${escapeHtml(mentor.topics)}</div>
          <div class="meta">公开留言：${escapeHtml(mentor.message)}</div>
        </article>
      `;
    }).join("")}
  `;

  $("#submitRound1")?.addEventListener("click", () => submitRound1(student));
  $("#submitRound2")?.addEventListener("click", () => submitRound2(student));
  $$("[data-round-choice]").forEach((button) => {
    button.addEventListener("click", () => {
      const [round, choice] = button.dataset.roundChoice.split("|");
      mutate("/api/student/round-choice", { studentId: student.id, round: Number(round), choice }, choice === "continue" ? "已选择继续匹配。" : "已退出后续匹配。");
    });
  });
  $("#toggleStudentScores").addEventListener("click", () => {
    state.showStudentScores = !state.showStudentScores;
    renderStudentView();
  });

  renderConversation("student", student.name, "#studentConversation");
}

function selectedPreferences() {
  return ["#round1Pref1", "#round1Pref2", "#round1Pref3"].map((selector) => $(selector)?.value).filter(Boolean);
}

function submitRound1(student) {
  const preferences = [...new Set(selectedPreferences())];
  if (!preferences.length) {
    showToast("请至少选择一位志愿导师。", "error");
    return;
  }
  if (preferences.length < 3 && !window.confirm("没有选满三个志愿，是否结束第一轮导师申请？")) {
    return;
  }
  mutate("/api/round1/apply", { studentId: student.id, preferences, message: $("#round1Message").value }, "第一轮志愿已提交。");
}

function submitRound2(student) {
  const mentorId = $("#round2Mentor").value;
  if (!mentorId) {
    showToast("请选择一位补录导师。", "error");
    return;
  }
  mutate("/api/round2/apply", { studentId: student.id, mentorId, message: $("#round2Message").value }, "第二轮补录申请已提交。");
}

function closeSwitchModal() {
  state.pendingSwitchMentorId = "";
  $("#switchModal").classList.add("hidden");
}

function renderMentorView() {
  const mentor = byId(state.mentors, state.currentMentorId);
  if (!mentor) return;
  const currentRound = Number(state.round_state.current_round || 1);
  const round = state.round_state.round1_closed && !state.round_state.round2_closed ? 2 : currentRound;
  const capacity = mentorCapacity(mentor.id);
  const accepted = mentorMatches(mentor.id).map((item) => ({ match: item, student: byId(state.students, item.student_id) })).filter((item) => item.student);
  const preacceptedCount = roundApplicationsForMentor(mentor.id, 1).filter((app) => app.status === "preaccepted").length;
  const visibleApplications = state.round_state.round1_closed
    ? state.round_applications.filter((app) => app.mentor_id === mentor.id)
    : roundApplicationsForMentor(mentor.id, round);
  let applicants = visibleApplications.map((app) => {
    const student = byId(state.students, app.student_id);
    return { ...app, student, match_percent: student ? matchPercentFor(student, mentor) : 0, lockedMatch: student ? matchForStudent(student.id) : null };
  }).filter((item) => item.student);
  if (state.mentorSort === "match") {
    applicants.sort((a, b) => b.match_percent - a.match_percent);
  } else {
    applicants.sort((a, b) => Number(a.round) - Number(b.round) || (a.preference_rank || 9) - (b.preference_rank || 9) || b.match_percent - a.match_percent);
  }

  $("#mentorProfile").innerHTML = `
    <h3>${escapeHtml(mentor.name)}</h3>
    <div class="meta">${escapeHtml(mentor.school)} · ${escapeHtml(mentor.industry)} · ${escapeHtml(mentor.title)}</div>
    <div class="pill-row">${tags(mentor.interests).map(pill).join("")}</div>
    <p>${escapeHtml(mentor.projects)}</p>
    <div class="meta">关注话题：${escapeHtml(mentor.topics)}</div>
    <div class="meta">补充留言：${escapeHtml(mentor.message)}</div>
  `;

  $("#mentorDecisionSummary").innerHTML = `
    <span class="badge ${accepted.length >= capacity ? "red" : "green"}">${round === 1 ? `预匹配 ${preacceptedCount}/${capacity}` : `已匹配 ${accepted.length}/${capacity}`}</span>
    <span>${state.round_state.round1_closed ? `历史/当前申请 ${applicants.length} 人` : `${roundLabel(round)}申请 ${applicants.length} 人`}</span>
    ${round === 1 ? `<span class="legend legend-r1">第一志愿</span><span class="legend legend-r2">第二志愿</span><span class="legend legend-r3">第三志愿</span>` : ""}
    <label class="compact-control">名额上限 <input id="mentorCapacityInput" type="number" min="${accepted.length || 1}" max="20" value="${capacity}" /></label>
    <button id="saveMentorCapacity" class="secondary">保存名额</button>
    <button id="sortByPreference" class="secondary ${state.mentorSort === "preference" ? "active-soft" : ""}">按志愿排序</button>
    <button id="sortByMatch" class="secondary ${state.mentorSort === "match" ? "active-soft" : ""}">按匹配度排序</button>
    <button id="toggleMentorScores" class="secondary">${state.showMentorScores ? "隐藏匹配度（%）" : "显示匹配度（%）"}</button>
  `;

  $("#acceptedStudents").innerHTML = accepted.length
    ? accepted.map(({ student, match }) => studentCard(student, mentor, { match_percent: matchPercentFor(student, mentor), round: match.round, status: "accepted" }, true)).join("")
    : `<div class="empty">目前还没有已接收的学员。</div>`;

  $("#applicantCards").innerHTML = applicants.length
    ? applicants.map((item) => studentCard(item.student, mentor, item, false)).join("")
    : `<div class="empty">暂无申请者。</div>`;

  $$("[data-select-student]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.mentorFull === "true") {
        showToast(Number(button.dataset.round) === 1 ? "当前名额已满，无法加入预匹配。" : "当前名额已满，无法接收该学员。", "error");
        return;
      }
      mutate("/api/mentor/select", { mentorId: mentor.id, studentId: button.dataset.selectStudent, round: Number(button.dataset.round) }, Number(button.dataset.round) === 1 ? "已加入预匹配。" : "已反选该学员。");
    });
  });
  $$("[data-reject-student]").forEach((button) => {
    button.addEventListener("click", () => mutate("/api/mentor/reject", { mentorId: mentor.id, studentId: button.dataset.rejectStudent, round: Number(button.dataset.round) }, "已拒绝该申请。"));
  });
  $("#toggleMentorScores").addEventListener("click", () => {
    state.showMentorScores = !state.showMentorScores;
    renderMentorView();
  });
  $("#sortByPreference").addEventListener("click", () => {
    state.mentorSort = "preference";
    renderMentorView();
  });
  $("#sortByMatch").addEventListener("click", () => {
    state.mentorSort = "match";
    renderMentorView();
  });
  $("#saveMentorCapacity").addEventListener("click", () => {
    mutate("/api/mentor/capacity", { mentorId: mentor.id, capacity: Number($("#mentorCapacityInput").value) }, "名额上限已更新。");
  });

  renderConversation("mentor", mentor.name, "#mentorConversation");
}

function studentCard(student, mentor, match, compact) {
  const lockedMatch = matchForStudent(student.id);
  const lockedByOther = lockedMatch && lockedMatch.mentor_id !== mentor.id;
  const alreadyAcceptedHere = lockedMatch?.mentor_id === mentor.id;
  const isRound1 = Number(match?.round || state.round_state.current_round) === 1;
  const lockedApp = lockedByOther ? roundApplicationsForStudent(student.id, Number(lockedMatch.round)).find((app) => app.mentor_id === lockedMatch.mentor_id) : null;
  const canOverrideWithHigherPreference = isRound1 && lockedByOther && Number(match?.preference_rank || 99) < Number(lockedApp?.preference_rank || 99);
  const historicalLocked = ["locked", "not_matched", "timeout"].includes(match?.status);
  const lockedUnavailable = (lockedByOther && !canOverrideWithHigherPreference) || historicalLocked;
  const lockedMessage = match?.status === "timeout" ? "匹配超时：截止前未完成决定" : match?.status === "not_matched" ? "本轮未最终匹配" : isRound1 ? "该学生已与更高志愿的导师匹配" : "已被其他导师匹配";
  const rankClass = isRound1 ? `preference-card rank-${match?.preference_rank || 0}` : "";
  const full = isMentorFull(mentor.id, match?.round || state.round_state.current_round);
  const isPreacceptedHere = match?.status === "preaccepted";
  const selectLabel = isRound1 ? "加入预匹配" : "反选学员";
  return `
    <article class="card applicant-card ${rankClass} ${lockedUnavailable ? "locked-card" : ""}">
      <header>
        <div>
          <h3>${escapeHtml(student.name)}</h3>
          <div class="meta">${escapeHtml(student.school)} · ${escapeHtml(student.major)}</div>
        </div>
        ${state.showMentorScores ? `<span class="badge">${percent(match?.match_percent || 0)}</span>` : ""}
      </header>
      <div class="pill-row">${tags(student.interests).map(pill).join("")}</div>
      <div class="meta">申请轮次：${roundLabel(Number(match?.round || state.round_state.current_round))}${match?.preference_rank ? ` · ${preferenceLabel(match.preference_rank)}` : ""}</div>
      <p>${escapeHtml(student.experience)}</p>
      ${compact ? "" : `<div class="meta">提前约定：${escapeHtml(student.pre_agreed_mentor || "无")}</div><div class="meta">原问卷意向导师：${escapeHtml(student.intended_mentor || "无")}</div>`}
      <div class="meta">公开问卷留言：${escapeHtml(student.message)}</div>
      ${match?.message ? `<div class="message"><strong>申请补充信息</strong><p>${escapeHtml(match.message)}</p></div>` : ""}
      <div class="actions">
        ${compact ? "" : alreadyAcceptedHere ? `<span class="badge green">最终匹配成功</span>` : isPreacceptedHere ? `<span class="badge amber">预匹配中（等待第一轮截止结算）</span><button class="reject" data-reject-student="${student.id}" data-round="1">撤回预匹配</button>` : lockedUnavailable ? `<span class="badge red">${lockedMessage}</span>` : match?.status === "rejected" ? `<span class="badge red">已拒绝</span>` : `<button class="accept" data-select-student="${student.id}" data-round="${match?.round || state.round_state.current_round}" data-mentor-full="${full ? "true" : "false"}">${canOverrideWithHigherPreference ? "按更高志愿预匹配" : selectLabel}</button>${full ? `<span class="badge red">满额</span>` : ""}${Number(match?.round) <= 2 ? `<button class="reject" data-reject-student="${student.id}" data-round="${match?.round || state.round_state.current_round}">拒绝</button>` : ""}`}
      </div>
    </article>
  `;
}

function renderAdminView() {
  const currentRound = Number(state.round_state.current_round || 1);
  const matched = state.matches.length;
  const unmatched = state.students.length - matched;
  $("#adminStats").innerHTML = [
    ["当前轮次", `第 ${currentRound} 轮`],
    ["导师数", state.mentors.length],
    ["学员数", state.students.length],
    ["已匹配", matched],
    ["未匹配", unmatched],
    ["第一轮申请", state.round_applications.filter((app) => Number(app.round) === 1).length],
    ["第二轮申请", state.round_applications.filter((app) => Number(app.round) === 2).length],
    ["反馈消息", state.feedback.length]
  ].map(([label, value]) => `<div class="stat"><strong>${value}</strong><span>${label}</span></div>`).join("");
  $$(".dashboard-tab").forEach((button) => button.classList.toggle("active", button.dataset.adminView === state.adminView));
  $("#adminSearch").value = state.adminSearch;
  renderAdminDashboard();
  renderAdminFeedback();
}

function matchesQuery(text) {
  const query = state.adminSearch.trim().toLowerCase();
  return !query || String(text || "").toLowerCase().includes(query);
}

function emptyDashboardMessage(entityName) {
  const query = state.adminSearch.trim();
  if (query) {
    return `<div class="empty">没有符合搜索条件的${entityName}。</div>`;
  }
  if (entityName === "学员" && state.adminStudentStatus !== "all") {
    return `<div class="empty">没有符合筛选条件的学员。</div>`;
  }
  if (!state.mentors.length || !state.students.length) {
    return `<div class="empty">数据还没有加载出来。请打开 http://127.0.0.1:4173/，不要直接打开 index.html 文件。</div>`;
  }
  return `<div class="empty">暂无${entityName}。</div>`;
}

function mentorOptions(selectedId = "") {
  return `<option value="">选择导师</option>${state.mentors.map((mentor) => `<option value="${mentor.id}" ${mentor.id === selectedId ? "selected" : ""}>${escapeHtml(mentor.name)}｜${escapeHtml(mentor.industry)}</option>`).join("")}`;
}

function applicationSummary(student) {
  const match = matchForStudent(student.id);
  const mentor = match ? byId(state.mentors, match.mentor_id) : null;
  const apps = roundApplicationsForStudent(student.id);
  const status = applicationStatusInfo(student);
  const label = match ? `${status.label}（第 ${match.round} 轮）` : status.label;
  return { match, mentor, apps, label, color: status.color, status };
}

function renderAdminDashboard() {
  const views = {
    matches: renderAdminMatchesDashboard,
    students: renderAdminStudentsDashboard,
    mentors: renderAdminMentorsDashboard,
    manual: renderManualMatchPanel,
    feedback: renderAdminFeedbackDashboard
  };
  $("#adminDashboard").innerHTML = views[state.adminView]();
  bindAdminDashboardActions();
}

function renderManualMatchPanel() {
  const unmatched = state.students.filter((student) => !matchForStudent(student.id) && roundChoiceForStudent(student.id, 3) === "continue");
  const availableMentors = state.mentors.filter((mentor) => mentorCapacityLeft(mentor.id) > 0);
  const enabled = Boolean(state.round_state.round2_closed) && !state.round_state.round3_closed;
  return `
    <section class="dashboard-card">
      <h4>人工匹配</h4>
      <p class="meta">${enabled ? "第二轮已经结束，管理员可以为仍未匹配的学员进行人工匹配。" : "该区域会在第二轮结束后启用；第一轮和第二轮进行中不能人工匹配。"}</p>
      <div class="inline-admin-action">
        <label>未匹配学员<select id="manualStudent" ${enabled ? "" : "disabled"}>${unmatched.map((student) => `<option value="${student.id}">${escapeHtml(student.name)}｜${escapeHtml(student.major)}｜${escapeHtml(student.interests)}</option>`).join("")}</select></label>
        <label>未招满导师<select id="manualMentor" ${enabled ? "" : "disabled"}>${availableMentors.map((mentor) => `<option value="${mentor.id}">${escapeHtml(mentor.name)}｜剩余 ${mentorCapacityLeft(mentor.id)} 位｜${escapeHtml(mentor.interests)}</option>`).join("")}</select></label>
        <button id="manualMatch" data-manual-enabled="${enabled ? "true" : "false"}">人工匹配</button>
      </div>
    </section>
  `;
}

function renderAdminMatchesDashboard() {
  const mentors = state.mentors.filter((mentor) => matchesQuery(`${mentor.name} ${mentor.school} ${mentor.industry} ${mentor.title} ${mentor.interests}`));
  const mentorCards = mentors.length ? mentors.map((mentor) => {
    const round1 = roundApplicationsForMentor(mentor.id, 1);
    const round2 = roundApplicationsForMentor(mentor.id, 2);
    const accepted = mentorMatches(mentor.id);
    const capacity = mentorCapacity(mentor.id);
    return `
      <article class="dashboard-card mentor-dashboard-card">
        <header>
          <div>
            <h4>${escapeHtml(mentor.name)}</h4>
            <div class="meta">${escapeHtml(mentor.school)} · ${escapeHtml(mentor.industry)} · ${escapeHtml(mentor.title)}</div>
          </div>
          <div class="pill-row">${pill(`第一轮 ${round1.length}`)}${pill(`第二轮 ${round2.length}`)}${pill(`已匹配 ${accepted.length}/${capacity}`)}${pill(accepted.length >= capacity ? "已满额" : `剩余 ${capacity - accepted.length}`)}</div>
        </header>
        <div class="dashboard-columns">
          <div>
            <strong>已匹配</strong>
            ${accepted.length ? accepted.map((item) => {
              const student = byId(state.students, item.student_id);
              return student ? adminMentorStudentLine(mentor, student, null, `第 ${item.round} 轮`, "green", { showUnpair: true }) : "";
            }).join("") : `<div class="empty compact-empty">暂无已匹配学员</div>`}
          </div>
          <div>
            <strong>申请概览</strong>
            ${[...round1, ...round2].length ? [...round1, ...round2].map((app) => {
              const student = byId(state.students, app.student_id);
              const locked = matchForStudent(app.student_id);
              return `<div class="mini-row"><span>${escapeHtml(student?.name || "")} · ${roundLabel(app.round)}${app.preference_rank ? ` · ${preferenceLabel(app.preference_rank)}` : ""}</span><span class="badge ${locked ? "green" : "amber"}">${locked ? "已匹配" : roundApplicationStatusLabel(app.status)}</span></div>`;
            }).join("") : `<div class="empty compact-empty">暂无申请</div>`}
          </div>
        </div>
      </article>
    `;
  }).join("") : emptyDashboardMessage("导师");
  return mentorCards;
}

function renderAdminStudentsDashboard() {
  const students = state.students.filter((student) => {
    const status = applicationStatusInfo(student);
    return matchesQuery(`${student.name} ${student.school} ${student.major} ${student.interests} ${student.experience} ${student.message}`) &&
      (state.adminStudentStatus === "all" || status.key === state.adminStudentStatus);
  });
  const statusOptions = [
    ["all", "全部状态"],
    ["submitted", "已提交"],
    ["preaccepted", "预匹配中"],
    ["accepted", "已接受"],
    ["rejected", "已拒绝"],
    ["full", "满额"],
    ["timeout", "超时"],
    ["exit", "已退出"],
    ["none", "未提交"]
  ];
  return students.length ? `
    <div class="dashboard-filter-row">
      <label>申请状态
        <select id="adminStudentStatusFilter">
          ${statusOptions.map(([value, label]) => `<option value="${value}" ${state.adminStudentStatus === value ? "selected" : ""}>${label}</option>`).join("")}
        </select>
      </label>
    </div>
    <div class="dashboard-table">
      <div class="dashboard-table-head student-table-row">
        <strong>学员</strong><strong>问卷方向</strong><strong>当前申请</strong><strong>管理员操作</strong>
      </div>
      ${students.map((student) => {
        const { match, mentor, apps, label, color } = applicationSummary(student);
        return `
          <div class="dashboard-table-row student-table-row">
            <div><strong>${escapeHtml(student.name)}</strong><div class="meta">${escapeHtml(student.school)} · ${escapeHtml(student.major)}</div></div>
            <div class="pill-row">${tags(student.interests).map(pill).join("")}</div>
            <div><span class="badge ${color}">${label}</span><div class="meta">${mentor ? escapeHtml(mentor.name) : apps.map((app) => `${roundLabel(app.round)} ${byId(state.mentors, app.mentor_id)?.name || ""}`).join("；") || "暂无申请"}</div></div>
            <div class="inline-admin-action">
              ${match && mentor ? `<button class="danger" data-admin-unpair="${student.id}|${mentor.id}">解除配对</button>` : `<span class="meta">可进入第三轮人工匹配</span>`}
            </div>
          </div>
        `;
      }).join("")}
    </div>
  ` : `
    <div class="dashboard-filter-row">
      <label>申请状态
        <select id="adminStudentStatusFilter">
          ${statusOptions.map(([value, label]) => `<option value="${value}" ${state.adminStudentStatus === value ? "selected" : ""}>${label}</option>`).join("")}
        </select>
      </label>
    </div>
    ${emptyDashboardMessage("学员")}
  `;
}

function adminMentorStudentLine(mentor, student, matchPercent, statusText, statusColor, options = {}) {
  return `
    <div class="mini-row">
      <span>${escapeHtml(student.name)}${matchPercent ? ` · ${percent(matchPercent)}` : ""}</span>
      <div class="actions">
        <span class="badge ${statusColor}">${statusText}</span>
        ${options.showUnpair ? `<button class="danger" data-admin-unpair="${student.id}|${mentor.id}">解除配对</button>` : ""}
        ${options.showCancel ? `<button class="danger" data-admin-cancel-application="${student.id}|${mentor.id}">撤销申请</button>` : ""}
      </div>
    </div>
  `;
}

function renderAdminMentorPanel(mentor, pool, accepted, all) {
  const activePanel = state.adminMentorPanels[mentor.id] || "accepted";
  const panelTitles = {
    pool: "第一轮申请",
    accepted: "已接收",
    all: "第二轮申请"
  };
  const rows = {
    pool: pool.map((item) => {
      const student = byId(state.students, item.student_id);
      const match = student ? matchForStudent(student.id) : null;
      const status = item.status === "preaccepted" ? ["预匹配中", "amber"] : item.status === "not_matched" ? ["未匹配", "red"] : match?.mentor_id === mentor.id ? ["最终匹配成功", "green"] : match ? ["该学员已与更高志愿匹配", "red"] : ["待导师反选", "amber"];
      return student ? adminMentorStudentLine(mentor, student, matchPercentFor(student, mentor), `${preferenceLabel(item.preference_rank)} · ${status[0]}`, status[1]) : "";
    }),
    accepted: accepted.map((item) => {
      const student = byId(state.students, item.student_id);
      return student ? adminMentorStudentLine(mentor, student, null, `第 ${item.round} 轮匹配`, "green", { showUnpair: true }) : "";
    }),
    all: all.map((app) => {
      const student = byId(state.students, app.student_id);
      const match = student ? matchForStudent(student.id) : null;
      const status = app.status === "rejected" ? ["已拒绝", "red"] : match?.mentor_id === mentor.id ? ["已匹配", "green"] : ["待导师决定", "amber"];
      return student ? adminMentorStudentLine(mentor, student, matchPercentFor(student, mentor), status[0], status[1]) : "";
    })
  };
  const emptyTexts = {
    pool: "暂无第一轮申请",
    accepted: "无已接收学员",
    all: "暂无第二轮申请"
  };
  const visibleRows = rows[activePanel].filter(Boolean);
  return `
    <div>
      <strong>${panelTitles[activePanel]}</strong>
      ${visibleRows.length ? visibleRows.join("") : `<div class="empty compact-empty">${emptyTexts[activePanel]}</div>`}
    </div>
  `;
}

function renderAdminMentorsDashboard() {
  const mentors = state.mentors.filter((mentor) => matchesQuery(`${mentor.name} ${mentor.school} ${mentor.industry} ${mentor.title} ${mentor.interests} ${mentor.projects} ${mentor.topics}`));
  return mentors.length ? `
    <div class="mentor-grid">${mentors.map((mentor) => {
    const round1 = roundApplicationsForMentor(mentor.id, 1);
    const round2 = roundApplicationsForMentor(mentor.id, 2);
    const accepted = mentorMatches(mentor.id);
    const capacity = mentorCapacity(mentor.id);
    const activePanel = state.adminMentorPanels[mentor.id] || "accepted";
    return `
      <article class="dashboard-card">
        <h4>${escapeHtml(mentor.name)}</h4>
        <div class="meta">${escapeHtml(mentor.school)} · ${escapeHtml(mentor.industry)} · ${escapeHtml(mentor.title)}</div>
        <div class="meta">名额上限：${capacity} · ${accepted.length >= capacity ? "已满额" : `剩余 ${capacity - accepted.length} 位`}</div>
        <div class="pill-row">${tags(mentor.interests).map(pill).join("")}</div>
        <div class="dashboard-metrics">
          <button class="dashboard-metric-button ${activePanel === "pool" ? "active" : ""}" data-admin-mentor-panel="${mentor.id}|pool"><strong>${round1.length}</strong><span>第一轮</span></button>
          <button class="dashboard-metric-button ${activePanel === "accepted" ? "active" : ""}" data-admin-mentor-panel="${mentor.id}|accepted"><strong>${accepted.length}</strong><span>已接收</span></button>
          <button class="dashboard-metric-button ${activePanel === "all" ? "active" : ""}" data-admin-mentor-panel="${mentor.id}|all"><strong>${round2.length}</strong><span>第二轮</span></button>
        </div>
        ${renderAdminMentorPanel(mentor, round1, accepted, round2)}
      </article>
    `;
  }).join("")}</div>` : emptyDashboardMessage("导师");
}

function renderAdminFeedbackDashboard() {
  return `<div id="feedbackList" class="feedback-list dashboard-feedback"></div>`;
}

function bindAdminDashboardActions() {
  $$("[data-admin-mentor-panel]").forEach((button) => {
    button.addEventListener("click", () => {
      const [mentorId, panel] = button.dataset.adminMentorPanel.split("|");
      state.adminMentorPanels[mentorId] = panel;
      renderAdminDashboard();
    });
  });
  $$("[data-admin-unpair]").forEach((button) => {
    button.addEventListener("click", () => {
      const [studentId, mentorId] = button.dataset.adminUnpair.split("|");
      mutate("/api/admin/unpair", { studentId, mentorId });
    });
  });
  $$("[data-admin-cancel-application]").forEach((button) => {
    button.addEventListener("click", () => {
      const [studentId, mentorId] = button.dataset.adminCancelApplication.split("|");
      mutate("/api/admin/cancel-application", { studentId, mentorId });
    });
  });
  $("#adminStudentStatusFilter")?.addEventListener("change", (event) => {
    state.adminStudentStatus = event.target.value;
    renderAdminDashboard();
  });
  $("#manualMatch")?.addEventListener("click", () => {
    if ($("#manualMatch").dataset.manualEnabled !== "true") {
      showToast("当前第三轮人工匹配尚未开始", "error");
      return;
    }
    const studentId = $("#manualStudent")?.value;
    const mentorId = $("#manualMentor")?.value;
    if (!studentId || !mentorId) {
      showToast("请选择学员和导师。", "error");
      return;
    }
    mutate("/api/admin/manual-match", { studentId, mentorId }, "已完成人工匹配。");
  });
}

function feedbackThreads() {
  const grouped = {};
  state.feedback.forEach((item) => {
    grouped[item.thread_id] ||= [];
    grouped[item.thread_id].push(item);
  });
  return Object.values(grouped);
}

function renderConversation(role, name, selector) {
  const threads = feedbackThreads().filter((messages) => messages.some((item) => item.from_role === role && item.from_name === name));
  $(selector).innerHTML = threads.length
    ? threads.map((messages) => `
      <div class="thread">
        ${[...messages].reverse().map((item) => `<div class="message ${item.from_role === "admin" ? "admin-message" : ""}"><strong>${escapeHtml(item.from_name)}</strong><p>${escapeHtml(item.content)}</p><div class="meta">${escapeHtml(item.created_at)}</div></div>`).join("")}
      </div>
    `).join("")
    : `<div class="empty">暂无反馈对话。</div>`;
}

function renderAdminFeedback() {
  if (!$("#feedbackList")) return;
  const threads = feedbackThreads().filter((messages) => {
    const text = messages.map((item) => `${item.from_name} ${item.content} ${item.created_at}`).join(" ");
    return matchesQuery(text);
  });
  $("#feedbackList").innerHTML = threads.length
    ? threads.map((messages) => {
      const first = messages[messages.length - 1];
      return `
        <div class="card">
          <strong>${escapeHtml(first.from_name)} 的反馈</strong>
          <div class="thread">
            ${[...messages].reverse().map((item) => `<div class="message ${item.from_role === "admin" ? "admin-message" : ""}"><strong>${escapeHtml(item.from_name)}</strong><p>${escapeHtml(item.content)}</p><div class="meta">${escapeHtml(item.created_at)}</div></div>`).join("")}
          </div>
          <div class="reply-row">
            <input data-reply-input="${first.thread_id}" placeholder="管理员回复" />
            <button data-reply="${first.thread_id}">回复</button>
          </div>
        </div>
      `;
    }).join("")
    : `<div class="empty">暂无异常反馈。</div>`;
  $$("[data-reply]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = $(`[data-reply-input="${button.dataset.reply}"]`);
      mutate("/api/feedback", { threadId: Number(button.dataset.reply), fromRole: "admin", fromName: "管理员", toRole: "user", content: input.value }, "管理员回复已发送。");
    });
  });
}

function renderAll() {
  $("#loginAccount").textContent = currentActor().name;
  renderStudentView();
  renderMentorView();
  renderAdminView();
}

function bindEvents() {
  $("#submitAccessCode").addEventListener("click", submitAccessCode);
  $("#accessCodeInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      submitAccessCode();
    }
  });
  $$(".login-choice").forEach((button) => {
    button.addEventListener("click", () => {
      const role = button.dataset.loginRole;
      if (role === "admin") {
        setRole("admin");
      } else {
        showAccountPicker(role);
      }
    });
  });
  $("#backToRole").addEventListener("click", backToRolePicker);
  $("#enterAccount").addEventListener("click", enterSelectedAccount);
  $("#logoutButton").addEventListener("click", logout);
  ["#industryFilter", "#interestFilter", "#mentorSearch"].forEach((selector) => $(selector).addEventListener("input", renderStudentView));
  $("#showAllApplicants").addEventListener("change", renderMentorView);
  $("#syncQuestionnaires").addEventListener("click", () => mutate("/api/import-csv", {}, "问卷数据已更新。"));
  $("#exportDatabase").addEventListener("click", exportDatabaseBackup);
  $("#endRound1").addEventListener("click", () => mutate("/api/admin/end-round", { round: 1 }, "第一轮已结束，通知已生成。"));
  $("#reopenRound1").addEventListener("click", () => {
    if (window.confirm("确认撤回第一轮结算并回到第一轮测试状态吗？这会清除后续轮次测试数据。")) {
      mutate("/api/admin/reopen-round1", {}, "已回到第一轮测试状态。");
    }
  });
  $("#endRound2").addEventListener("click", () => mutate("/api/admin/end-round", { round: 2 }, "第二轮已结束，通知已生成。"));
  $("#endRound3").addEventListener("click", () => mutate("/api/admin/end-round", { round: 3 }, "第三轮已结束，通知已生成。"));
  $$(".dashboard-tab").forEach((button) => {
    button.addEventListener("click", () => {
      state.adminView = button.dataset.adminView;
      renderAdminView();
    });
  });
  $("#adminSearch").addEventListener("input", (event) => {
    state.adminSearch = event.target.value;
    renderAdminView();
  });
  $("#sendStudentFeedback").addEventListener("click", () => {
    const student = byId(state.students, state.currentStudentId);
    mutate("/api/feedback", { fromRole: "student", fromName: student.name, toRole: "admin", content: $("#studentFeedback").value }, "反馈已发送。");
    $("#studentFeedback").value = "";
  });
  $("#sendMentorFeedback").addEventListener("click", () => {
    const mentor = byId(state.mentors, state.currentMentorId);
    mutate("/api/feedback", { fromRole: "mentor", fromName: mentor.name, toRole: "admin", content: $("#mentorFeedback").value }, "反馈已发送。");
    $("#mentorFeedback").value = "";
  });
  $("#cancelSwitch").addEventListener("click", closeSwitchModal);
  $("#confirmSwitch").addEventListener("click", () => {
    const student = byId(state.students, state.currentStudentId);
    const mentorId = state.pendingSwitchMentorId;
    closeSwitchModal();
    if (student && mentorId) {
      mutate("/api/apply", { studentId: student.id, mentorId }, "已撤回原申请，并切换意向导师。");
    }
  });
}

async function init() {
  await loadConfig();
  if (state.accessRequired && !window.sessionStorage.getItem(accessStorageKey)) {
    showAccessScreen();
    return;
  }
  try {
    await loadState();
    showLoginScreen();
  } catch (error) {
    if (state.accessRequired) {
      window.sessionStorage.removeItem(accessStorageKey);
      showAccessScreen();
    }
    showToast(error.message, "error");
  }
}

bindEvents();
init().catch((error) => showToast(error.message, "error"));
