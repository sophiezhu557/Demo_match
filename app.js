const state = {
  mentors: [],
  students: [],
  applications: [],
  pools: [],
  decisions: [],
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
  adminMentorPanels: {},
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

async function exportCurrentState() {
  try {
    const data = await api("/api/state");
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" });
    downloadBlob(blob, `abc-mentor-state-${exportTimestamp()}.json`);
    showToast("当前状态已导出。");
  } catch (error) {
    showToast(error.message, "error");
  }
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

function renderStudentView() {
  const student = byId(state.students, state.currentStudentId);
  if (!student) return;
  const application = applicationForStudent(student.id);
  const mentor = application ? byId(state.mentors, application.mentor_id) : null;
  const [progress, progressColor] = progressLabel(application?.status);

  $("#studentProgress").innerHTML = `
    <div class="progress-item">
      <strong>当前导师</strong>
      <span>${escapeHtml(mentor?.name || "尚未申请")}</span>
    </div>
    <div class="progress-item">
      <strong>申请进度</strong>
      <span class="badge ${progressColor}">${progress}</span>
    </div>
    <div class="progress-item">
      <strong>申请规则</strong>
      <span>每位学员只能申请 1 位导师</span>
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
  `;

  const industry = $("#industryFilter").value;
  const interest = $("#interestFilter").value;
  const query = $("#mentorSearch").value.trim().toLowerCase();
  const filtered = state.mentors.filter((mentor) => {
    const haystack = `${mentor.name} ${mentor.school} ${mentor.industry} ${mentor.title} ${mentor.projects} ${mentor.topics} ${mentor.message}`.toLowerCase();
    return (!industry || mentor.industry === industry) && (!interest || tags(mentor.interests).includes(interest)) && (!query || haystack.includes(query));
  }).sort((a, b) => matchPercentFor(student, b) - matchPercentFor(student, a));

  $("#mentorCards").innerHTML = filtered.map((mentor) => {
    const applied = application?.mentor_id === mentor.id;
    const accepted = application?.status === "accepted";
    const matchValue = matchPercentFor(student, mentor);
    const buttonText = applied ? (accepted ? "已被接收" : "当前申请") : (application ? "切换为这位导师" : "申请这位导师");
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
        <div class="meta">留言：${escapeHtml(mentor.message)}</div>
        <button data-apply="${mentor.id}" ${applied || accepted ? "disabled" : ""}>${buttonText}</button>
      </article>
    `;
  }).join("");

  $$("[data-apply]").forEach((button) => {
    button.addEventListener("click", () => handleApplyClick(student, button.dataset.apply));
  });
  $("#toggleStudentScores").addEventListener("click", () => {
    state.showStudentScores = !state.showStudentScores;
    renderStudentView();
  });

  renderConversation("student", student.name, "#studentConversation");
}

function handleApplyClick(student, mentorId) {
  const application = applicationForStudent(student.id);
  if (!application) {
    mutate("/api/apply", { studentId: student.id, mentorId });
    return;
  }
  const previousMentor = byId(state.mentors, application.mentor_id);
  state.pendingSwitchMentorId = mentorId;
  $("#switchModalText").textContent = `每个学员只能申请一位导师，是否确定放弃${previousMentor?.name || "前一位导师"}的申请？`;
  $("#switchModal").classList.remove("hidden");
}

function closeSwitchModal() {
  state.pendingSwitchMentorId = "";
  $("#switchModal").classList.add("hidden");
}

function renderMentorView() {
  const mentor = byId(state.mentors, state.currentMentorId);
  if (!mentor) return;
  const pool = poolForMentor(mentor.id);
  const allApplicants = state.applications
    .filter((app) => app.mentor_id === mentor.id)
    .map((app) => {
      const poolItem = state.pools.find((item) => item.mentor_id === mentor.id && item.student_id === app.student_id);
      return poolItem || { mentor_id: mentor.id, student_id: app.student_id, match_percent: 0, reason: "未进入默认选择池" };
    })
    .sort((a, b) => b.match_percent - a.match_percent);
  const visible = $("#showAllApplicants").checked ? allApplicants : pool;
  const accepted = acceptedApplications().filter((item) => item.mentor.id === mentor.id);

  $("#mentorProfile").innerHTML = `
    <h3>${escapeHtml(mentor.name)}</h3>
    <div class="meta">${escapeHtml(mentor.school)} · ${escapeHtml(mentor.industry)} · ${escapeHtml(mentor.title)}</div>
    <div class="pill-row">${tags(mentor.interests).map(pill).join("")}</div>
    <p>${escapeHtml(mentor.projects)}</p>
    <div class="meta">关注话题：${escapeHtml(mentor.topics)}</div>
    <div class="meta">补充留言：${escapeHtml(mentor.message)}</div>
  `;

  $("#mentorDecisionSummary").innerHTML = `
    <span class="badge green">已接收 ${accepted.length}/3</span>
    <span>选择池 ${pool.length} 人</span>
    <span>总申请 ${allApplicants.length} 人</span>
    <button id="toggleMentorScores" class="secondary">${state.showMentorScores ? "隐藏匹配度（%）" : "显示匹配度（%）"}</button>
  `;

  $("#acceptedStudents").innerHTML = accepted.length
    ? accepted.map(({ student }) => studentCard(student, mentor, pool.find((item) => item.student_id === student.id), true)).join("")
    : `<div class="empty">目前还没有已接收的学员。</div>`;

  $("#applicantCards").innerHTML = visible.length
    ? visible.map((item) => studentCard(byId(state.students, item.student_id), mentor, item, false)).join("")
    : `<div class="empty">暂无申请者。</div>`;

  $$("[data-decision]").forEach((button) => {
    button.addEventListener("click", () => mutate("/api/decision", { mentorId: mentor.id, studentId: button.dataset.student, decision: button.dataset.decision }));
  });
  $("#toggleMentorScores").addEventListener("click", () => {
    state.showMentorScores = !state.showMentorScores;
    renderMentorView();
  });

  renderConversation("mentor", mentor.name, "#mentorConversation");
}

function studentCard(student, mentor, match, compact) {
  const decision = decisionFor(mentor.id, student.id);
  const acceptedCount = acceptedApplications().filter((item) => item.mentor.id === mentor.id).length;
  return `
    <article class="card">
      <header>
        <div>
          <h3>${escapeHtml(student.name)}</h3>
          <div class="meta">${escapeHtml(student.school)} · ${escapeHtml(student.major)}</div>
        </div>
        ${state.showMentorScores ? `<span class="badge">${percent(match?.match_percent || 0)}</span>` : ""}
      </header>
      <div class="pill-row">${tags(student.interests).map(pill).join("")}</div>
      <div class="meta">优先原因：${escapeHtml(match?.reason || "未进入默认选择池")}</div>
      <p>${escapeHtml(student.experience)}</p>
      ${compact ? "" : `<div class="meta">提前约定：${escapeHtml(student.pre_agreed_mentor || "无")}</div><div class="meta">意向导师：${escapeHtml(student.intended_mentor || "无")}</div>`}
      <div class="meta">补充留言：${escapeHtml(student.message)}</div>
      <div class="actions">
        <button class="accept" data-decision="accepted" data-student="${student.id}" ${acceptedCount >= 3 && decision?.decision !== "accepted" ? "disabled" : ""}>接收</button>
        <button class="reject" data-decision="rejected" data-student="${student.id}">拒绝</button>
        ${decision ? `<span class="badge ${decision.decision === "accepted" ? "green" : "red"}">${decision.decision === "accepted" ? "已接收" : "已拒绝"}</span>` : ""}
      </div>
    </article>
  `;
}

function renderAdminView() {
  const inPool = state.pools.length;
  const accepted = state.applications.filter((app) => app.status === "accepted").length;
  const notMatched = state.applications.filter((app) => app.status === "not_matched").length;
  $("#adminStats").innerHTML = [
    ["导师数", state.mentors.length],
    ["学员数", state.students.length],
    ["选择池中", inPool],
    ["已接收", accepted],
    ["未匹配", notMatched],
    ["反馈消息", state.feedback.length]
  ].map(([label, value]) => `<div class="stat"><strong>${value}</strong><span>${label}</span></div>`).join("");
  $$(".dashboard-tab").forEach((button) => button.classList.toggle("active", button.dataset.adminView === state.adminView));
  $("#adminSearch").value = state.adminSearch;
  renderAdminDashboard();
  renderAdminFeedback();
}

function matchesQuery(text) {
  return !state.adminSearch || String(text || "").toLowerCase().includes(state.adminSearch.toLowerCase());
}

function mentorOptions(selectedId = "") {
  return `<option value="">选择导师</option>${state.mentors.map((mentor) => `<option value="${mentor.id}" ${mentor.id === selectedId ? "selected" : ""}>${escapeHtml(mentor.name)}｜${escapeHtml(mentor.industry)}</option>`).join("")}`;
}

function applicationSummary(student) {
  const application = applicationForStudent(student.id);
  const mentor = application ? byId(state.mentors, application.mentor_id) : null;
  const [label, color] = application ? statusLabel(application.status) : ["未提交", "amber"];
  return { application, mentor, label, color };
}

function renderAdminDashboard() {
  const views = {
    matches: renderAdminMatchesDashboard,
    students: renderAdminStudentsDashboard,
    mentors: renderAdminMentorsDashboard,
    feedback: renderAdminFeedbackDashboard
  };
  $("#adminDashboard").innerHTML = views[state.adminView]();
  bindAdminDashboardActions();
}

function renderAdminMatchesDashboard() {
  const mentors = state.mentors.filter((mentor) => matchesQuery(`${mentor.name} ${mentor.school} ${mentor.industry} ${mentor.title} ${mentor.interests}`));
  return mentors.length ? mentors.map((mentor) => {
    const pool = poolForMentor(mentor.id);
    const all = state.applications.filter((app) => app.mentor_id === mentor.id);
    const poolIds = new Set(pool.map((item) => item.student_id));
    const overflow = all.filter((app) => !poolIds.has(app.student_id));
    const accepted = acceptedApplications().filter((item) => item.mentor.id === mentor.id);
    return `
      <article class="dashboard-card mentor-dashboard-card">
        <header>
          <div>
            <h4>${escapeHtml(mentor.name)}</h4>
            <div class="meta">${escapeHtml(mentor.school)} · ${escapeHtml(mentor.industry)} · ${escapeHtml(mentor.title)}</div>
          </div>
          <div class="pill-row">${pill(`选择池 ${pool.length}/8`)}${pill(`已接收 ${accepted.length}/3`)}${pill(`总申请 ${all.length}`)}</div>
        </header>
        <div class="dashboard-columns">
          <div>
            <strong>选择池</strong>
            ${pool.length ? pool.map((item) => {
              const student = byId(state.students, item.student_id);
              const decision = decisionFor(mentor.id, student.id);
              const status = decision?.decision === "accepted" ? ["已接收", "green"] : decision?.decision === "rejected" ? ["导师已拒绝", "red"] : ["待导师决定", "amber"];
              return `
                <div class="mini-row">
                  <span>${escapeHtml(student.name)} · ${percent(item.match_percent)}</span>
                  <div class="actions">
                    <span class="badge ${status[1]}">${status[0]}</span>
                    ${decision?.decision === "accepted" ? `<button class="danger" data-admin-unpair="${student.id}|${mentor.id}">解除配对</button>` : ""}
                  </div>
                </div>
              `;
            }).join("") : `<div class="empty compact-empty">暂无选择池学员</div>`}
          </div>
          <div>
            <strong>未入池</strong>
            ${overflow.length ? overflow.map((app) => `<div class="mini-row"><span>${escapeHtml(byId(state.students, app.student_id).name)}</span><span class="badge red">系统未匹配</span></div>`).join("") : `<div class="empty compact-empty">无未入池申请</div>`}
          </div>
        </div>
      </article>
    `;
  }).join("") : `<div class="empty">没有符合搜索条件的导师。</div>`;
}

function renderAdminStudentsDashboard() {
  const students = state.students.filter((student) => matchesQuery(`${student.name} ${student.school} ${student.major} ${student.interests} ${student.experience} ${student.message}`));
  return students.length ? `
    <div class="dashboard-table">
      <div class="dashboard-table-head student-table-row">
        <strong>学员</strong><strong>问卷方向</strong><strong>当前申请</strong><strong>管理员操作</strong>
      </div>
      ${students.map((student) => {
        const { application, mentor, label, color } = applicationSummary(student);
        return `
          <div class="dashboard-table-row student-table-row">
            <div><strong>${escapeHtml(student.name)}</strong><div class="meta">${escapeHtml(student.school)} · ${escapeHtml(student.major)}</div></div>
            <div class="pill-row">${tags(student.interests).map(pill).join("")}</div>
            <div><span class="badge ${color}">${label}</span><div class="meta">${mentor ? escapeHtml(mentor.name) : "暂无申请"}</div></div>
            <div class="inline-admin-action">
              ${application?.status === "accepted" && mentor ? `<button class="danger" data-admin-unpair="${student.id}|${mentor.id}">解除配对</button>` : `<span class="meta">无可用操作</span>`}
            </div>
          </div>
        `;
      }).join("")}
    </div>
  ` : `<div class="empty">没有符合搜索条件的学员。</div>`;
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
  const poolByStudent = new Map(pool.map((item) => [item.student_id, item]));
  const panelTitles = {
    pool: "选择池",
    accepted: "已接收",
    all: "总申请"
  };
  const rows = {
    pool: pool.map((item) => {
      const student = byId(state.students, item.student_id);
      const decision = student ? decisionFor(mentor.id, student.id) : null;
      const status = decision?.decision === "accepted" ? ["已接收", "green"] : decision?.decision === "rejected" ? ["导师已拒绝", "red"] : ["待导师决定", "amber"];
      return student ? adminMentorStudentLine(mentor, student, item.match_percent, status[0], status[1]) : "";
    }),
    accepted: accepted.map((item) => adminMentorStudentLine(mentor, item.student, null, "已接收", "green", { showUnpair: true })),
    all: all.map((app) => {
      const student = byId(state.students, app.student_id);
      const poolItem = poolByStudent.get(app.student_id);
      const decision = student ? decisionFor(mentor.id, student.id) : null;
      const status = decision?.decision === "accepted" ? ["已接收", "green"] : decision?.decision === "rejected" ? ["导师已拒绝", "red"] : poolItem ? ["待导师决定", "amber"] : ["系统未匹配", "red"];
      return student ? adminMentorStudentLine(mentor, student, poolItem?.match_percent, status[0], status[1], { showCancel: !decision }) : "";
    })
  };
  const emptyTexts = {
    pool: "暂无选择池学员",
    accepted: "无已接收学员",
    all: "暂无申请"
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
  return mentors.length ? `<div class="mentor-grid">${mentors.map((mentor) => {
    const pool = poolForMentor(mentor.id);
    const all = state.applications.filter((app) => app.mentor_id === mentor.id);
    const accepted = acceptedApplications().filter((item) => item.mentor.id === mentor.id);
    const activePanel = state.adminMentorPanels[mentor.id] || "accepted";
    return `
      <article class="dashboard-card">
        <h4>${escapeHtml(mentor.name)}</h4>
        <div class="meta">${escapeHtml(mentor.school)} · ${escapeHtml(mentor.industry)} · ${escapeHtml(mentor.title)}</div>
        <div class="pill-row">${tags(mentor.interests).map(pill).join("")}</div>
        <div class="dashboard-metrics">
          <button class="dashboard-metric-button ${activePanel === "pool" ? "active" : ""}" data-admin-mentor-panel="${mentor.id}|pool"><strong>${pool.length}</strong><span>选择池</span></button>
          <button class="dashboard-metric-button ${activePanel === "accepted" ? "active" : ""}" data-admin-mentor-panel="${mentor.id}|accepted"><strong>${accepted.length}</strong><span>已接收</span></button>
          <button class="dashboard-metric-button ${activePanel === "all" ? "active" : ""}" data-admin-mentor-panel="${mentor.id}|all"><strong>${all.length}</strong><span>总申请</span></button>
        </div>
        ${renderAdminMentorPanel(mentor, pool, accepted, all)}
      </article>
    `;
  }).join("")}</div>` : `<div class="empty">没有符合搜索条件的导师。</div>`;
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
  $("#exportState").addEventListener("click", exportCurrentState);
  $("#exportDatabase").addEventListener("click", exportDatabaseBackup);
  $("#rerunMatching").addEventListener("click", () => mutate("/api/rerun", {}, "匹配已重新计算。"));
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
