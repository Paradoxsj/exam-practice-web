(function () {
  "use strict";

  const DATA_ROOT = "./data/";
  const STORAGE_KEYS = {
    records: "quiz_records_v1",
    wrongBook: "quiz_wrong_book_v1",
    subjective: "quiz_subjective_status_v1",
    session: "quiz_session_v1",
    exam: "quiz_exam_session_v1",
    legacy: "staticQuizState.v1",
  };
  const OBJECTIVE_TYPES = new Set(["single", "single_choice", "judge", "multiple", "multiple_choice"]);

  const els = {
    loadStatus: document.getElementById("loadStatus"),
    paperList: document.getElementById("paperList"),
    togglePapers: document.getElementById("togglePapers"),
    sequenceModeBtn: document.getElementById("sequenceModeBtn"),
    randomModeBtn: document.getElementById("randomModeBtn"),
    examModeBtn: document.getElementById("examModeBtn"),
    reshuffleBtn: document.getElementById("reshuffleBtn"),
    searchInput: document.getElementById("searchInput"),
    filterTabs: document.getElementById("filterTabs"),
    statsGrid: document.getElementById("statsGrid"),
    numberNav: document.getElementById("numberNav"),
    openToolsPanelBtn: document.getElementById("openToolsPanelBtn"),
    closeToolsPanelBtn: document.getElementById("closeToolsPanelBtn"),
    toolsPanelBackdrop: document.getElementById("toolsPanelBackdrop"),
    openNumberNavBtn: document.getElementById("openNumberNavBtn"),
    closeNumberNavBtn: document.getElementById("closeNumberNavBtn"),
    numberNavBackdrop: document.getElementById("numberNavBackdrop"),
    clearWrongBtn: document.getElementById("clearWrongBtn"),
    currentPaperTitle: document.getElementById("currentPaperTitle"),
    questionProgress: document.getElementById("questionProgress"),
    questionType: document.getElementById("questionType"),
    saveHint: document.getElementById("saveHint"),
    questionStem: document.getElementById("questionStem"),
    optionsArea: document.getElementById("optionsArea"),
    answerArea: document.getElementById("answerArea"),
    prevBtn: document.getElementById("prevBtn"),
    submitBtn: document.getElementById("submitBtn"),
    examSubmitBtn: document.getElementById("examSubmitBtn"),
    nextBtn: document.getElementById("nextBtn"),
    toast: document.getElementById("toast"),
  };

  const store = createStore();
  const app = {
    papers: [],
    currentPaper: null,
    questions: [],
    filtered: [],
    currentIndex: 0,
    filter: "all",
    search: "",
    showExplanation: false,
    autoNextTimer: null,
    transientCorrectId: "",
    records: store.load("records", {}),
    wrongBook: store.load("wrongBook", {}),
    subjective: store.load("subjective", {}),
    session: normalizeSession(store.load("session", {})),
    exam: store.load("exam", {}),
  };

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    migrateLegacyState();
    bindEvents();
    await loadPapers();
  }

  function bindEvents() {
    els.togglePapers.addEventListener("click", () => {
      els.paperList.classList.toggle("collapsed");
    });

    els.sequenceModeBtn.addEventListener("click", () => setMode("sequence"));
    els.randomModeBtn.addEventListener("click", () => setMode("random"));
    els.examModeBtn.addEventListener("click", () => setMode("exam"));
    els.reshuffleBtn.addEventListener("click", reshuffleCurrentPaper);

    els.searchInput.addEventListener("input", () => {
      app.search = els.searchInput.value.trim();
      applyFilters(true);
    });

    els.filterTabs.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-filter]");
      if (!button) return;
      app.filter = button.dataset.filter;
      setActiveFilterButton();
      applyFilters(true);
    });

    els.prevBtn.addEventListener("click", () => moveQuestion(-1));
    els.nextBtn.addEventListener("click", () => moveQuestion(1));
    els.submitBtn.addEventListener("click", submitCurrentAnswer);
    els.examSubmitBtn.addEventListener("click", submitExam);
    els.clearWrongBtn.addEventListener("click", clearCurrentPaperWrongBook);
    els.openToolsPanelBtn.addEventListener("click", openToolsPanel);
    els.closeToolsPanelBtn.addEventListener("click", closeToolsPanel);
    els.toolsPanelBackdrop.addEventListener("click", closeToolsPanel);
    els.openNumberNavBtn.addEventListener("click", openNumberDrawer);
    els.closeNumberNavBtn.addEventListener("click", closeNumberDrawer);
    els.numberNavBackdrop.addEventListener("click", closeNumberDrawer);
  }

  async function loadPapers() {
    try {
      const response = await fetch(`${DATA_ROOT}papers.json`);
      if (!response.ok) throw new Error(`papers.json HTTP ${response.status}`);
      app.papers = await response.json();
      ensureSessionShape();
      els.loadStatus.textContent = `已加载 ${app.papers.length} 份试卷`;
      renderPaperList();

      const lastPaperId = app.session.currentPaperId || app.papers[0]?.paperId;
      if (lastPaperId) {
        const paper = app.papers.find((item) => item.paperId === lastPaperId) || app.papers[0];
        await loadPaper(paper.paperId);
      }
    } catch (error) {
      els.loadStatus.textContent = "试卷加载失败";
      renderEmpty(`无法加载 ./data/papers.json：${error.message}`);
      console.error(error);
    }
  }

  function renderPaperList() {
    els.paperList.innerHTML = "";
    app.papers.forEach((paper) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `paper-item${app.currentPaper?.paperId === paper.paperId ? " active" : ""}`;
      button.dataset.paperId = paper.paperId;
      button.innerHTML = `
        <span class="paper-title">${escapeHtml(paper.title || paper.paperId)}</span>
        <span class="paper-meta">${paper.questionCount || 0} 题</span>
        <span class="paper-types">${formatTypes(paper.types || {})}</span>
      `;
      button.addEventListener("click", () => loadPaper(paper.paperId));
      els.paperList.appendChild(button);
    });
  }

  async function loadPaper(paperId) {
    clearAutoNext();
    const paper = app.papers.find((item) => item.paperId === paperId);
    if (!paper) return;

    app.currentPaper = paper;
    closePaperListOnMobile();
    app.showExplanation = false;
    app.currentIndex = 0;
    app.session.currentPaperId = paperId;
    saveSession();
    renderPaperList();

    try {
      const fileName = `${safeFileName(paperId)}.json`;
      const response = await fetch(`${DATA_ROOT}${encodeURIComponent(fileName)}`);
      if (!response.ok) throw new Error(`${fileName} HTTP ${response.status}`);
      app.questions = await response.json();
      if (currentMode() === "exam" && app.exam?.paperId !== paperId) {
        startNewExam(paperId);
        saveExam();
      }
      ensurePaperSession(paperId);
      applyFilters(false);

      if (currentMode() === "exam") {
        app.currentIndex = Math.min(Math.max(app.exam.currentIndex || 0, 0), Math.max(app.filtered.length - 1, 0));
      } else {
        const paperSession = getPaperSession(paperId);
        if (paperSession.currentQuestionId) {
          const savedIndex = app.filtered.findIndex((question) => getQuestionId(question) === paperSession.currentQuestionId);
          app.currentIndex = savedIndex >= 0 ? savedIndex : 0;
        } else if (Number.isInteger(paperSession.currentIndex)) {
          app.currentIndex = Math.min(Math.max(paperSession.currentIndex, 0), Math.max(app.filtered.length - 1, 0));
        }
      }
      renderAll();
    } catch (error) {
      app.questions = [];
      app.filtered = [];
      renderEmpty(`无法加载试卷 JSON：${error.message}`);
      console.error(error);
    }
  }

  function applyFilters(resetIndex) {
    const keyword = app.search.toLowerCase();
    app.filtered = orderedQuestions().filter((question) => {
      if (currentMode() === "exam") return true;
      const qid = getQuestionId(question);
      const type = normalizeType(question.type);
      const record = app.records[qid];
      const wrong = app.wrongBook[qid];
      const subjective = app.subjective[qid];

      if (keyword) {
        const haystack = [question.stem, question.explanation, ...Object.values(question.options || {})]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(keyword)) return false;
      }

      if (app.filter === "unanswered") {
        return isObjective(type) ? !record?.submitted : !subjective?.status;
      }
      if (app.filter === "wrongAll") return Boolean(wrong);
      if (app.filter === "wrong") return wrong?.status === "wrong";
      if (app.filter === "corrected") return wrong?.status === "corrected";
      if (app.filter === "mastered") return type === "subjective" && subjective?.status === "mastered";
      if (app.filter === "unmastered") return type === "subjective" && subjective?.status === "unmastered";
      return true;
    });

    if (resetIndex) app.currentIndex = 0;
    if (app.currentIndex >= app.filtered.length) app.currentIndex = Math.max(0, app.filtered.length - 1);
    renderAll();
  }

  function renderAll() {
    renderModeControls();
    renderStats();
    renderNumberNav();
    renderQuestion();
    renderPaperList();
  }

  function renderStats() {
    if (currentMode() === "exam") {
      renderExamStats();
      return;
    }
    const stats = getStats();
    const cells = [
      ["总题数", stats.total],
      ["已答题数", stats.answered],
      ["正确数", stats.correct],
      ["错误数", stats.wrong],
      ["正确率", stats.rate],
      ["错题数", stats.wrongBook],
    ];
    els.statsGrid.innerHTML = cells
      .map(([label, value]) => `<div class="stat-cell"><strong>${value}</strong><span>${label}</span></div>`)
      .join("");
  }

  function renderExamStats() {
    const summary = getExamSummary();
    const submitted = app.exam?.status === "submitted";
    const cells = submitted
      ? [
          ["正确数", summary.correct],
          ["错误数", summary.wrong],
          ["未答题数", summary.unanswered],
          ["正确率", summary.rate],
          ["客观题", summary.objective],
          ["主观题", summary.subjective],
        ]
      : [
          ["总题数", summary.total],
          ["已答题数", summary.answered],
          ["未答题数", summary.unanswered],
          ["当前进度", `${Math.min(app.currentIndex + 1, summary.total)} / ${summary.total}`],
          ["客观题", summary.objective],
          ["主观题", summary.subjective],
        ];
    els.statsGrid.innerHTML = cells
      .map(([label, value]) => `<div class="stat-cell"><strong>${value}</strong><span>${label}</span></div>`)
      .join("");
  }

  function renderNumberNav() {
    els.numberNav.innerHTML = "";
    if (!app.filtered.length) {
      els.numberNav.innerHTML = `<div class="empty-state">没有符合条件的题目。</div>`;
      return;
    }

    app.filtered.forEach((question, index) => {
      const button = document.createElement("button");
      const qid = getQuestionId(question);
      const record = app.records[qid];
      const wrong = app.wrongBook[qid];
      const subjective = app.subjective[qid];
      const examAnswer = app.exam?.answers?.[qid];
      const examResult = app.exam?.result?.byQuestion?.[qid];
      const classes = [];
      if (index === app.currentIndex) classes.push("current");
      if (currentMode() === "exam") {
        if (app.exam.status === "submitted") {
          if (examResult?.type === "subjective") classes.push("subjective");
          else if (examResult?.correct) classes.push("correct");
          else classes.push("wrong");
        } else if (examAnswer) {
          classes.push("answered");
        }
      } else {
        if (record?.submitted && record.correct) classes.push("correct");
        if (wrong?.status === "wrong") classes.push("wrong");
        if (wrong?.status === "corrected") classes.push("corrected");
        if (subjective?.status === "mastered") classes.push("mastered");
        if (subjective?.status === "unmastered") classes.push("unmastered");
      }

      button.className = classes.join(" ");
      button.type = "button";
      button.textContent = question.number ?? index + 1;
      button.title = `第 ${index + 1} / ${app.filtered.length} 题 · 原题号 ${question.number ?? index + 1}`;
      button.addEventListener("click", () => {
        clearAutoNext();
        app.currentIndex = index;
        app.showExplanation = false;
        rememberProgress();
        closeNumberDrawer();
        renderAll();
      });
      els.numberNav.appendChild(button);
    });
  }

  function renderQuestion() {
    const question = app.filtered[app.currentIndex];
    els.optionsArea.innerHTML = "";
    els.answerArea.innerHTML = "";
    els.submitBtn.classList.remove("hidden");
    els.examSubmitBtn.classList.add("hidden");

    if (!question) {
      renderEmpty(app.questions.length ? "没有符合当前筛选条件的题目。" : "从左侧选择一份试卷开始刷题。");
      return;
    }

    const type = normalizeType(question.type);
    const qid = getQuestionId(question);
    const record = app.records[qid];
    const originalNumber = question.number ?? app.currentIndex + 1;
    els.currentPaperTitle.textContent = app.currentPaper?.title || app.currentPaper?.paperId || "请选择试卷";
    els.questionProgress.textContent = `第 ${app.currentIndex + 1} / ${app.filtered.length} 题 · 原题号 ${originalNumber}`;
    els.questionType.textContent = typeLabel(type);
    els.questionStem.textContent = question.stem || "（题干为空）";
    els.prevBtn.disabled = app.currentIndex <= 0;
    els.nextBtn.disabled = app.currentIndex >= app.filtered.length - 1;

    if (currentMode() === "exam") {
      renderExamQuestion(question, type);
    } else if (isObjective(type)) {
      renderObjectiveOptions(question, type, record);
      renderObjectiveFeedback(question, type, record);
      els.submitBtn.textContent = record?.submitted ? "重新提交" : "提交";
      els.submitBtn.disabled = false;
    } else {
      renderManualQuestion(question, type);
      els.submitBtn.classList.add("hidden");
    }

    rememberProgress();
  }

  function renderObjectiveOptions(question, type, record) {
    const inputType = type === "multiple" || type === "multiple_choice" ? "checkbox" : "radio";
    const answerSet = new Set((record?.userAnswer || "").split(""));
    const options = normalizedOptions(question, type);

    Object.entries(options).forEach(([key, value]) => {
      const label = document.createElement("label");
      label.className = "option-row";
      label.innerHTML = `
        <input type="${inputType}" name="currentAnswer" value="${escapeHtml(key)}" ${answerSet.has(key) ? "checked" : ""} />
        <span class="option-label"><strong>${escapeHtml(key)}.</strong> ${escapeHtml(value)}</span>
      `;
      els.optionsArea.appendChild(label);
    });
  }

  function renderExamQuestion(question, type) {
    const qid = getQuestionId(question);
    const submitted = app.exam.status === "submitted";
    const examAnswer = app.exam.answers?.[qid] || "";
    els.submitBtn.classList.add("hidden");
    els.examSubmitBtn.classList.toggle("hidden", submitted);

    if (isObjective(type)) {
      renderExamObjectiveOptions(question, type, examAnswer, submitted);
    } else {
      renderExamManualQuestion(question, examAnswer, submitted);
    }
    if (submitted) {
      renderExamReview(question, type);
      renderExamResultPanel();
    } else {
      els.answerArea.innerHTML = `<div class="feedback neutral">模拟考试进行中：答案已自动保存，交卷前不显示正确答案和解析。</div>`;
    }
  }

  function renderExamObjectiveOptions(question, type, examAnswer, disabled) {
    const inputType = type === "multiple" || type === "multiple_choice" ? "checkbox" : "radio";
    const answerSet = new Set((examAnswer || "").split(""));
    const options = normalizedOptions(question, type);
    Object.entries(options).forEach(([key, value]) => {
      const label = document.createElement("label");
      label.className = "option-row";
      label.innerHTML = `
        <input type="${inputType}" name="currentAnswer" value="${escapeHtml(key)}" ${answerSet.has(key) ? "checked" : ""} ${disabled ? "disabled" : ""} />
        <span class="option-label"><strong>${escapeHtml(key)}.</strong> ${escapeHtml(value)}</span>
      `;
      els.optionsArea.appendChild(label);
    });
    if (!disabled) {
      els.optionsArea.querySelectorAll('input[name="currentAnswer"]').forEach((input) => {
        input.addEventListener("change", () => saveExamAnswer(question, getSelectedAnswer(type)));
      });
    }
  }

  function renderExamManualQuestion(question, examAnswer, submitted) {
    const escaped = escapeHtml(examAnswer || "");
    els.optionsArea.innerHTML = `
      <div class="feedback neutral">
        <strong>主观题不参与自动评分</strong>
        <div>${submitted ? "交卷后可查看参考答案/解析。" : "可填写简短自评或标记已作答。"}</div>
      </div>
      <textarea class="blank-note" id="examManualAnswer" placeholder="写一点自评或作答摘要" ${submitted ? "disabled" : ""}>${escaped}</textarea>
      ${
        submitted
          ? ""
          : `<div class="subjective-actions"><button type="button" id="examMarkDoneBtn">标记已作答</button><button type="button" id="examClearManualBtn">清空</button></div>`
      }
    `;
    if (!submitted) {
      document.getElementById("examManualAnswer").addEventListener("input", (event) => {
        saveExamAnswer(question, event.target.value.trim());
      });
      document.getElementById("examMarkDoneBtn").addEventListener("click", () => {
        const textarea = document.getElementById("examManualAnswer");
        const value = textarea.value.trim() || "已作答";
        textarea.value = value;
        saveExamAnswer(question, value);
      });
      document.getElementById("examClearManualBtn").addEventListener("click", () => {
        document.getElementById("examManualAnswer").value = "";
        saveExamAnswer(question, "");
      });
    }
  }

  function renderExamReview(question, type) {
    const qid = getQuestionId(question);
    const item = app.exam.result?.byQuestion?.[qid];
    if (!item) return;
    if (item.type === "subjective") {
      els.answerArea.innerHTML = `
        <div class="feedback neutral">
          <strong>主观题</strong>
          <div>你的记录：${escapeHtml(item.userAnswer || "未作答")}</div>
          <div class="explanation">${escapeHtml(question.explanation || question.answer || "暂无参考内容")}</div>
        </div>
      `;
      return;
    }
    els.answerArea.innerHTML = `
      <div class="feedback ${item.correct ? "correct" : "wrong"}">
        <strong>${item.correct ? "回答正确" : "回答错误"}</strong>
        <div>你的答案：${escapeHtml(item.userAnswer || "未选择")}</div>
        <div>正确答案：${escapeHtml(item.correctAnswer || "无")}</div>
        <div class="explanation">${escapeHtml(question.explanation || "暂无解析")}</div>
      </div>
    `;
  }

  function renderExamResultPanel() {
    if (currentMode() !== "exam" || app.exam?.status !== "submitted" || !app.exam.result) return;
    const result = app.exam.result;
    const wrongItems = result.wrongList || [];
    const subjectiveItems = result.subjectiveList || [];
    const wrongHtml = wrongItems.length
      ? wrongItems
          .map((item) => `<button type="button" class="result-link" data-qid="${escapeHtml(item.questionId)}">原题号 ${escapeHtml(item.number)} · ${escapeHtml(item.stem || "").slice(0, 36)}</button>`)
          .join("")
      : `<span class="muted-text">没有客观错题。</span>`;
    const subjectiveHtml = subjectiveItems.length
      ? subjectiveItems
          .map((item) => `<button type="button" class="result-link" data-qid="${escapeHtml(item.questionId)}">原题号 ${escapeHtml(item.number)} · ${escapeHtml(item.stem || "").slice(0, 36)}</button>`)
          .join("")
      : `<span class="muted-text">没有主观题。</span>`;
    els.answerArea.insertAdjacentHTML(
      "afterbegin",
      `
        <div class="exam-result-panel">
          <strong>本次模拟考试结果</strong>
          <div class="result-metrics">
            <span>总题数 ${result.total}</span>
            <span>客观题 ${result.objective}</span>
            <span>主观题 ${result.subjective}</span>
            <span>已答 ${result.answered}</span>
            <span>未答 ${result.unanswered}</span>
            <span>正确 ${result.correct}</span>
            <span>错误 ${result.wrong}</span>
            <span>正确率 ${result.rate}</span>
          </div>
          <details>
            <summary>错题列表 (${wrongItems.length})</summary>
            <div class="result-list">${wrongHtml}</div>
          </details>
          <details>
            <summary>主观题 (${subjectiveItems.length})</summary>
            <div class="result-list">${subjectiveHtml}</div>
          </details>
        </div>
      `
    );
    els.answerArea.querySelectorAll(".result-link").forEach((button) => {
      button.addEventListener("click", () => jumpToQuestionId(button.dataset.qid));
    });
  }

  function renderObjectiveFeedback(question, type, record) {
    if (!record?.submitted) return;
    const qid = getQuestionId(question);
    const wrong = app.wrongBook[qid];
    const className = record.correct ? "correct" : "wrong";
    const correctedBadge = wrong?.status === "corrected" ? `<span class="small-badge">已订正</span>` : "";
    const tools = wrong
      ? `<div class="subjective-actions"><button type="button" id="removeWrongBtn">从错题本移除</button>${correctedBadge}</div>`
      : "";
    const shortCorrect = record.correct && app.transientCorrectId === qid;
    const explanation = record.correct
      ? shortCorrect
        ? ""
        : `
        <div>你的答案：${escapeHtml(record.userAnswer || "未选择")}</div>
        <div>正确答案：${escapeHtml(record.correctAnswer || "无")}</div>
        <div class="explanation">${escapeHtml(question.explanation || "暂无解析")}</div>
      `
      : `
        <div>你的答案：${escapeHtml(record.userAnswer || "未选择")}</div>
        <div>正确答案：${escapeHtml(record.correctAnswer || "无")}</div>
        <div class="explanation">${escapeHtml(question.explanation || "暂无解析")}</div>
      `;
    els.answerArea.innerHTML = `
      <div class="feedback ${className}">
        <strong>${record.correct ? "回答正确" : "回答错误"}</strong>
        ${explanation}
        ${tools}
      </div>
    `;
    const removeBtn = document.getElementById("removeWrongBtn");
    if (removeBtn) {
      removeBtn.addEventListener("click", () => {
        delete app.wrongBook[qid];
        saveWrongBook();
        applyFilters(false);
      });
    }
  }

  function renderManualQuestion(question, type) {
    const qid = getQuestionId(question);
    const status = app.subjective[qid]?.status || "";
    const note = app.subjective[qid]?.note || "";
    const isBlank = type === "blank";
    const label = isBlank ? "填空题不自动判分" : "主观题不自动判分";
    const answerTitle = isBlank ? "参考答案" : "参考答案/解析";

    els.optionsArea.innerHTML = `
      <div class="feedback neutral">
        <strong>${label}</strong>
        <div>可先作答，再查看${answerTitle}并手动标记掌握状态。</div>
      </div>
      <textarea class="blank-note" id="manualNote" placeholder="可在这里记录自己的作答">${escapeHtml(note)}</textarea>
      <div class="subjective-actions">
        <button type="button" id="toggleExplanationBtn">${app.showExplanation ? "收起参考答案/解析" : "查看参考答案/解析"}</button>
        <button type="button" id="markMasteredBtn">掌握</button>
        <button type="button" id="markUnmasteredBtn">未掌握</button>
        ${status ? `<span class="mastery-status ${status}">${status === "mastered" ? "已掌握" : "未掌握"}</span>` : ""}
      </div>
    `;
    els.answerArea.innerHTML = app.showExplanation
      ? `<div class="feedback neutral"><strong>${answerTitle}</strong><div class="explanation">${escapeHtml(question.explanation || question.answer || "暂无参考内容")}</div></div>`
      : "";

    document.getElementById("manualNote").addEventListener("input", (event) => {
      setSubjectiveStatus(question, status || "unmastered", event.target.value);
    });
    document.getElementById("toggleExplanationBtn").addEventListener("click", () => {
      app.showExplanation = !app.showExplanation;
      renderQuestion();
    });
    document.getElementById("markMasteredBtn").addEventListener("click", () => setSubjectiveStatus(question, "mastered", document.getElementById("manualNote").value));
    document.getElementById("markUnmasteredBtn").addEventListener("click", () => setSubjectiveStatus(question, "unmastered", document.getElementById("manualNote").value));
  }

  function submitCurrentAnswer() {
    const question = app.filtered[app.currentIndex];
    if (!question) return;
    const type = normalizeType(question.type);
    if (!isObjective(type)) return;

    const selected = getSelectedAnswer(type);
    if (!selected) {
      els.answerArea.innerHTML = `<div class="feedback neutral">请先选择答案。</div>`;
      return;
    }

    const qid = getQuestionId(question);
    const correctAnswer = normalizeAnswer(question.answer);
    const correct = compareAnswers(selected, correctAnswer, type);
    app.records[qid] = {
      questionId: qid,
      paperId: question.paperId,
      number: question.number,
      type,
      userAnswer: selected,
      correctAnswer,
      correct,
      submitted: true,
      updatedAt: new Date().toISOString(),
    };

    if (correct) {
      if (app.wrongBook[qid]) {
        app.wrongBook[qid].status = "corrected";
        app.wrongBook[qid].userAnswer = selected;
        app.wrongBook[qid].correctAnswer = correctAnswer;
        app.wrongBook[qid].correctedAt = new Date().toISOString();
      }
      saveRecords();
      saveWrongBook();
      app.transientCorrectId = qid;
      renderAll();
      showToast("回答正确，马上进入下一题");
      clearAutoNext();
      app.autoNextTimer = window.setTimeout(() => {
        app.autoNextTimer = null;
        app.transientCorrectId = "";
        if (app.currentIndex < app.filtered.length - 1) {
          moveQuestion(1);
        }
      }, 600);
      return;
    }

    app.wrongBook[qid] = buildWrongItem(question, selected, correctAnswer, app.wrongBook[qid]);
    saveRecords();
    saveWrongBook();
    renderAll();
  }

  function saveExamAnswer(question, answer, updateChrome = true) {
    if (currentMode() !== "exam" || app.exam.status === "submitted") return;
    const qid = getQuestionId(question);
    app.exam.answers = app.exam.answers || {};
    const value = typeof answer === "string" ? answer.trim() : "";
    if (value) app.exam.answers[qid] = value;
    else delete app.exam.answers[qid];
    app.exam.currentIndex = app.currentIndex;
    saveExam();
    if (updateChrome) {
      renderStats();
      renderNumberNav();
    }
  }

  function submitExam() {
    if (currentMode() !== "exam" || !app.currentPaper || app.exam.status === "submitted") return;
    const summary = getExamSummary();
    const confirmed = window.confirm(
      `确认交卷吗？\n\n总题数：${summary.total}\n已答题数：${summary.answered}\n未答题数：${summary.unanswered}\n\n交卷后不可继续修改本次考试答案。`
    );
    if (!confirmed) return;
    app.exam.status = "submitted";
    app.exam.submittedAt = new Date().toISOString();
    app.exam.currentIndex = app.currentIndex;
    app.exam.result = buildExamResult();
    applyExamResultToWrongBook(app.exam.result);
    saveExam();
    saveWrongBook();
    renderAll();
  }

  function buildExamResult() {
    const byQuestion = {};
    const wrongList = [];
    const subjectiveList = [];
    let objective = 0;
    let subjective = 0;
    let answered = 0;
    let unanswered = 0;
    let correct = 0;
    let wrong = 0;

    orderedQuestions().forEach((question) => {
      const qid = getQuestionId(question);
      const type = normalizeType(question.type);
      const userAnswer = normalizeAnswer(app.exam.answers?.[qid] || "");
      if (isObjective(type)) {
        objective += 1;
        const correctAnswer = normalizeAnswer(question.answer);
        if (!userAnswer) {
          unanswered += 1;
          byQuestion[qid] = { type, userAnswer: "", correctAnswer, correct: false, unanswered: true };
          return;
        }
        answered += 1;
        const isCorrect = compareAnswers(userAnswer, correctAnswer, type);
        if (isCorrect) correct += 1;
        else {
          wrong += 1;
          wrongList.push({
            questionId: qid,
            number: question.number,
            stem: question.stem || "",
            userAnswer,
            correctAnswer,
          });
        }
        byQuestion[qid] = { type, userAnswer, correctAnswer, correct: isCorrect, unanswered: false };
        return;
      }

      subjective += 1;
      const manualAnswer = app.exam.answers?.[qid] || "";
      if (manualAnswer) answered += 1;
      else unanswered += 1;
      const item = {
        type: "subjective",
        userAnswer: manualAnswer,
        correctAnswer: "",
        correct: null,
        unanswered: !manualAnswer,
      };
      byQuestion[qid] = item;
      subjectiveList.push({
        questionId: qid,
        number: question.number,
        stem: question.stem || "",
        userAnswer: manualAnswer,
      });
    });

    const rate = objective ? `${Math.round((correct / objective) * 100)}%` : "0%";
    return {
      total: app.questions.length,
      objective,
      subjective,
      answered,
      unanswered,
      correct,
      wrong,
      rate,
      wrongList,
      subjectiveList,
      byQuestion,
    };
  }

  function applyExamResultToWrongBook(result) {
    app.questions.forEach((question) => {
      const qid = getQuestionId(question);
      const item = result.byQuestion?.[qid];
      if (!item || item.type === "subjective" || item.unanswered) return;
      if (item.correct) {
        if (app.wrongBook[qid]) {
          app.wrongBook[qid].status = "corrected";
          app.wrongBook[qid].userAnswer = item.userAnswer;
          app.wrongBook[qid].correctAnswer = item.correctAnswer;
          app.wrongBook[qid].correctedAt = new Date().toISOString();
        }
      } else {
        app.wrongBook[qid] = buildWrongItem(question, item.userAnswer, item.correctAnswer, app.wrongBook[qid]);
      }
    });
  }

  function buildWrongItem(question, userAnswer, correctAnswer, existing) {
    const now = new Date().toISOString();
    return {
      questionId: getQuestionId(question),
      paperId: question.paperId,
      number: question.number,
      type: normalizeType(question.type),
      stem: question.stem || "",
      userAnswer,
      correctAnswer,
      wrongCount: (existing?.wrongCount || 0) + 1,
      lastWrongAt: now,
      status: "wrong",
    };
  }

  function getSelectedAnswer(type) {
    const checked = Array.from(document.querySelectorAll('input[name="currentAnswer"]:checked')).map((input) => input.value);
    if (type === "multiple" || type === "multiple_choice") {
      return checked.map((item) => item.toUpperCase()).sort().join("");
    }
    return (checked[0] || "").toUpperCase();
  }

  function compareAnswers(selected, correct, type) {
    if (!correct) return false;
    if (type === "multiple" || type === "multiple_choice") {
      return selected.split("").sort().join("") === correct.split("").sort().join("");
    }
    return selected === correct;
  }

  function setSubjectiveStatus(question, status, note) {
    const qid = getQuestionId(question);
    app.subjective[qid] = {
      questionId: qid,
      paperId: question.paperId,
      number: question.number,
      type: normalizeType(question.type),
      status,
      note: note || "",
      updatedAt: new Date().toISOString(),
    };
    saveSubjective();
    renderAll();
  }

  function moveQuestion(delta) {
    clearAutoNext();
    app.transientCorrectId = "";
    if (!app.filtered.length) return;
    app.currentIndex = Math.min(Math.max(app.currentIndex + delta, 0), app.filtered.length - 1);
    app.showExplanation = false;
    rememberProgress();
    renderAll();
  }

  function clearCurrentPaperWrongBook() {
    if (!app.currentPaper) return;
    const total = app.questions.filter((question) => app.wrongBook[getQuestionId(question)]).length;
    if (!total) return;
    const confirmed = window.confirm(`确认清空当前试卷的 ${total} 条错题记录吗？`);
    if (!confirmed) return;
    app.questions.forEach((question) => delete app.wrongBook[getQuestionId(question)]);
    saveWrongBook();
    applyFilters(false);
  }

  function rememberProgress() {
    const question = app.filtered[app.currentIndex];
    if (!app.currentPaper || !question) return;
    if (currentMode() === "exam") {
      app.exam.currentIndex = app.currentIndex;
      saveExam();
    }
    app.session.progress = app.session.progress || {};
    app.session.progress[app.currentPaper.paperId] = getQuestionId(question);
    const paperSession = getPaperSession(app.currentPaper.paperId);
    paperSession.currentIndex = app.currentIndex;
    paperSession.currentQuestionId = getQuestionId(question);
    saveSession();
  }

  function getStats() {
    let answered = 0;
    let correct = 0;
    let wrong = 0;
    let wrongBook = 0;

    app.questions.forEach((question) => {
      const qid = getQuestionId(question);
      const type = normalizeType(question.type);
      const record = app.records[qid];
      const subjective = app.subjective[qid];
      const wrongItem = app.wrongBook[qid];

      if (isObjective(type) && record?.submitted) {
        answered += 1;
        if (record.correct) correct += 1;
        else wrong += 1;
      }
      if (!isObjective(type) && subjective?.status) {
        answered += 1;
      }
      if (wrongItem) {
        wrongBook += 1;
      }
    });

    const judged = correct + wrong;
    return {
      total: app.questions.length,
      answered,
      correct,
      wrong,
      rate: judged ? `${Math.round((correct / judged) * 100)}%` : "0%",
      wrongBook,
    };
  }

  function getExamSummary() {
    const answers = app.exam?.answers || {};
    const submittedResult = app.exam?.status === "submitted" ? app.exam.result : null;
    if (submittedResult) {
      return submittedResult;
    }
    let objective = 0;
    let subjective = 0;
    let answered = 0;
    app.questions.forEach((question) => {
      const qid = getQuestionId(question);
      const type = normalizeType(question.type);
      if (isObjective(type)) objective += 1;
      else subjective += 1;
      if (answers[qid]) answered += 1;
    });
    return {
      total: app.questions.length,
      objective,
      subjective,
      answered,
      unanswered: Math.max(app.questions.length - answered, 0),
      correct: 0,
      wrong: 0,
      rate: "0%",
    };
  }

  function setActiveFilterButton() {
    els.filterTabs.querySelectorAll("button").forEach((button) => {
      button.classList.toggle("active", button.dataset.filter === app.filter);
    });
  }

  function renderModeControls() {
    const mode = currentMode();
    els.sequenceModeBtn.classList.toggle("active", mode === "sequence");
    els.randomModeBtn.classList.toggle("active", mode === "random");
    els.examModeBtn.classList.toggle("active", mode === "exam");
    els.reshuffleBtn.classList.toggle("hidden", mode !== "random");
    els.searchInput.disabled = mode === "exam";
    els.filterTabs.querySelectorAll("button").forEach((button) => {
      button.disabled = mode === "exam";
    });
  }

  function setMode(mode) {
    if (!["sequence", "random", "exam"].includes(mode) || currentMode() === mode) return;
    clearAutoNext();
    if (mode === "exam") {
      enterExamMode();
      return;
    }
    app.session.mode = mode;
    if (app.currentPaper) {
      ensurePaperSession(app.currentPaper.paperId);
      const paperSession = getPaperSession(app.currentPaper.paperId);
      paperSession.mode = mode;
      paperSession.currentIndex = 0;
      paperSession.currentQuestionId = "";
      if (mode === "random") {
        ensureRandomOrder(app.currentPaper.paperId, false);
      }
    }
    app.currentIndex = 0;
    app.showExplanation = false;
    saveSession();
    applyFilters(true);
  }

  function enterExamMode() {
    if (!app.currentPaper) return;
    const paperId = app.currentPaper.paperId;
    const existing = app.exam?.paperId === paperId ? app.exam : null;
    if (existing?.status === "in_progress") {
      const continueExam = window.confirm("检测到当前试卷有未交卷的模拟考试。确定继续上次考试，取消则重新开始。");
      if (!continueExam) {
        const restart = window.confirm("确认重新开始模拟考试吗？上次未交卷答案会被覆盖。");
        if (!restart) return;
        startNewExam(paperId);
      }
    } else if (existing?.status === "submitted") {
      const review = window.confirm("当前试卷已有已交卷结果。确定回看结果，取消则重新开始模拟考试。");
      if (!review) {
        const restart = window.confirm("确认重新开始模拟考试吗？新的考试会覆盖上次考试会话。");
        if (!restart) return;
        startNewExam(paperId);
      }
    } else {
      startNewExam(paperId);
    }
    app.session.mode = "exam";
    app.search = "";
    els.searchInput.value = "";
    app.filter = "all";
    setActiveFilterButton();
    const index = Number.isInteger(app.exam.currentIndex) ? app.exam.currentIndex : 0;
    app.currentIndex = Math.min(Math.max(index, 0), Math.max(app.questions.length - 1, 0));
    app.showExplanation = false;
    saveSession();
    saveExam();
    applyFilters(false);
  }

  function startNewExam(paperId) {
    app.exam = {
      paperId,
      examId: `${paperId}-${Date.now()}`,
      status: "in_progress",
      order: shuffle(app.questions.map(getQuestionId)),
      currentIndex: 0,
      answers: {},
      startedAt: new Date().toISOString(),
      submittedAt: "",
      result: null,
    };
  }

  function reshuffleCurrentPaper() {
    if (!app.currentPaper || currentMode() !== "random") return;
    const confirmed = window.confirm("确认重新随机当前试卷的题目顺序吗？当前题位置会回到第 1 题。");
    if (!confirmed) return;
    ensureRandomOrder(app.currentPaper.paperId, true);
    const paperSession = getPaperSession(app.currentPaper.paperId);
    paperSession.currentIndex = 0;
    paperSession.currentQuestionId = "";
    app.currentIndex = 0;
    app.showExplanation = false;
    saveSession();
    applyFilters(true);
  }

  function orderedQuestions() {
    if (app.currentPaper && currentMode() === "exam") {
      ensureExamOrder();
      return orderByIds(app.exam.order);
    }
    if (!app.currentPaper || currentMode() !== "random") {
      return app.questions.slice();
    }
    const order = ensureRandomOrder(app.currentPaper.paperId, false);
    const byId = new Map(app.questions.map((question) => [getQuestionId(question), question]));
    const used = new Set();
    const ordered = [];
    order.forEach((qid) => {
      const question = byId.get(qid);
      if (question) {
        ordered.push(question);
        used.add(qid);
      }
    });
    app.questions.forEach((question) => {
      const qid = getQuestionId(question);
      if (!used.has(qid)) ordered.push(question);
    });
    return ordered;
  }

  function orderByIds(order) {
    const byId = new Map(app.questions.map((question) => [getQuestionId(question), question]));
    const used = new Set();
    const ordered = [];
    (Array.isArray(order) ? order : []).forEach((qid) => {
      const question = byId.get(qid);
      if (question) {
        ordered.push(question);
        used.add(qid);
      }
    });
    app.questions.forEach((question) => {
      const qid = getQuestionId(question);
      if (!used.has(qid)) ordered.push(question);
    });
    return ordered;
  }

  function currentMode() {
    if (app.session.mode === "random") return "random";
    if (app.session.mode === "exam") return "exam";
    return "sequence";
  }

  function ensureSessionShape() {
    app.session = normalizeSession(app.session);
    saveSession();
  }

  function normalizeSession(value) {
    const session = value && typeof value === "object" ? value : {};
    return {
      currentPaperId: session.currentPaperId || "",
      mode: ["sequence", "random", "exam"].includes(session.mode) ? session.mode : "sequence",
      progress: session.progress || {},
      papers: session.papers || {},
    };
  }

  function getPaperSession(paperId) {
    app.session.papers = app.session.papers || {};
    app.session.papers[paperId] = app.session.papers[paperId] || {
      mode: currentMode(),
      randomOrder: [],
      currentIndex: 0,
      currentQuestionId: "",
    };
    return app.session.papers[paperId];
  }

  function ensurePaperSession(paperId) {
    const paperSession = getPaperSession(paperId);
    paperSession.mode = currentMode();
    if (!Array.isArray(paperSession.randomOrder)) {
      paperSession.randomOrder = [];
    }
    if (currentMode() === "random") {
      ensureRandomOrder(paperId, false);
    }
    saveSession();
  }

  function ensureRandomOrder(paperId, forceNew) {
    const paperSession = getPaperSession(paperId);
    const ids = app.questions.map(getQuestionId);
    const idSet = new Set(ids);
    const existing = Array.isArray(paperSession.randomOrder) ? paperSession.randomOrder.filter((qid) => idSet.has(qid)) : [];
    const missing = ids.filter((qid) => !existing.includes(qid));
    if (forceNew || existing.length !== ids.length || missing.length) {
      paperSession.randomOrder = shuffle(ids);
    } else {
      paperSession.randomOrder = existing;
    }
    return paperSession.randomOrder;
  }

  function ensureExamOrder() {
    if (!app.currentPaper) return;
    if (!app.exam || app.exam.paperId !== app.currentPaper.paperId) {
      startNewExam(app.currentPaper.paperId);
    }
    const ids = app.questions.map(getQuestionId);
    const idSet = new Set(ids);
    const existing = Array.isArray(app.exam.order) ? app.exam.order.filter((qid) => idSet.has(qid)) : [];
    const missing = ids.filter((qid) => !existing.includes(qid));
    if (existing.length !== ids.length || missing.length) {
      app.exam.order = existing.concat(shuffle(missing));
    }
    saveExam();
  }

  function shuffle(items) {
    const result = items.slice();
    for (let index = result.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
    }
    return result;
  }

  function renderEmpty(message) {
    els.currentPaperTitle.textContent = app.currentPaper ? app.currentPaper.title : "请选择试卷";
    els.questionProgress.textContent = app.currentPaper ? app.currentPaper.title : "请选择试卷";
    els.questionType.textContent = "";
    els.questionStem.textContent = message;
    els.optionsArea.innerHTML = "";
    els.answerArea.innerHTML = "";
    els.numberNav.innerHTML = `<div class="empty-state">${escapeHtml(message)}</div>`;
    els.prevBtn.disabled = true;
    els.nextBtn.disabled = true;
    els.submitBtn.disabled = true;
  }

  function jumpToQuestionId(qid) {
    const index = app.filtered.findIndex((question) => getQuestionId(question) === qid);
    if (index < 0) return;
    app.currentIndex = index;
    closeNumberDrawer();
    rememberProgress();
    renderAll();
  }

  function openNumberDrawer() {
    closeToolsPanel();
    document.body.classList.add("number-nav-open");
  }

  function closeNumberDrawer() {
    document.body.classList.remove("number-nav-open");
  }

  function openToolsPanel() {
    closeNumberDrawer();
    document.body.classList.add("tools-panel-open");
  }

  function closeToolsPanel() {
    document.body.classList.remove("tools-panel-open");
  }

  function closePaperListOnMobile() {
    if (window.matchMedia("(max-width: 768px)").matches) {
      els.paperList.classList.add("collapsed");
    }
  }

  function normalizedOptions(question, type) {
    if (type === "judge") {
      return { A: "正确", B: "错误" };
    }
    const options = question.options || {};
    return Object.fromEntries(
      Object.entries(options)
        .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== "")
        .map(([key, value]) => [key.toUpperCase(), String(value)])
    );
  }

  function normalizeType(type) {
    const raw = String(type || "").trim().toLowerCase();
    if (raw === "single_choice") return "single";
    if (raw === "unknown") return "subjective";
    return raw || "subjective";
  }

  function isObjective(type) {
    return OBJECTIVE_TYPES.has(type);
  }

  function normalizeAnswer(answer) {
    return String(answer || "").replace(/\s+/g, "").toUpperCase();
  }

  function getQuestionId(question) {
    return question.questionId || `${question.paperId}-${question.number}`;
  }

  function typeLabel(type) {
    return {
      single: "单选题",
      single_choice: "单选题",
      judge: "判断题",
      multiple: "多选题",
      multiple_choice: "多选题",
      blank: "填空题",
      subjective: "主观题",
      unknown: "主观题",
    }[type] || "题目";
  }

  function formatTypes(types) {
    const labels = {
      single: "单选",
      judge: "判断",
      multiple: "多选",
      multiple_choice: "多选",
      blank: "填空",
      subjective: "主观",
      unknown: "主观",
    };
    return Object.entries(types)
      .map(([key, value]) => `${labels[key] || key} ${value}`)
      .join(" · ");
  }

  function safeFileName(value) {
    return (
      String(value || "paper")
        .normalize("NFKC")
        .replace(/[\\/:*?"<>|]+/g, "_")
        .replace(/\s+/g, "_")
        .replace(/^[._\s]+|[._\s]+$/g, "") || "paper"
    );
  }

  function showToast(message) {
    els.toast.textContent = message;
    els.toast.classList.add("show");
    window.setTimeout(() => els.toast.classList.remove("show"), 700);
  }

  function clearAutoNext() {
    if (app.autoNextTimer) {
      window.clearTimeout(app.autoNextTimer);
      app.autoNextTimer = null;
    }
  }

  function createStore() {
    return {
      load(name, fallback) {
        try {
          const raw = localStorage.getItem(STORAGE_KEYS[name]);
          return raw ? JSON.parse(raw) : fallback;
        } catch (error) {
          console.warn(`读取 ${STORAGE_KEYS[name]} 失败`, error);
          return fallback;
        }
      },
      save(name, value) {
        localStorage.setItem(STORAGE_KEYS[name], JSON.stringify(value));
      },
    };
  }

  function saveRecords() {
    store.save("records", app.records);
  }

  function saveWrongBook() {
    store.save("wrongBook", app.wrongBook);
  }

  function saveSubjective() {
    store.save("subjective", app.subjective);
  }

  function saveSession() {
    store.save("session", app.session);
  }

  function saveExam() {
    store.save("exam", app.exam || {});
  }

  function migrateLegacyState() {
    if (localStorage.getItem(STORAGE_KEYS.records)) return;
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.legacy);
      if (!raw) return;
      const legacy = JSON.parse(raw);
      app.session.currentPaperId = legacy.currentPaperId || app.session.currentPaperId || "";
      app.session.progress = legacy.progress || app.session.progress || {};
      app.session.mode = app.session.mode === "random" ? "random" : "sequence";
      app.session.papers = app.session.papers || {};
      Object.entries(legacy.answers || {}).forEach(([qid, value]) => {
        app.records[qid] = {
          questionId: qid,
          paperId: value.paperId || "",
          number: value.number || "",
          type: value.type || "",
          userAnswer: value.answer || "",
          correctAnswer: value.correctAnswer || "",
          correct: Boolean(value.correct),
          submitted: Boolean(value.submitted),
          updatedAt: value.updatedAt || new Date().toISOString(),
        };
      });
      Object.entries(legacy.wrong || {}).forEach(([qid, value]) => {
        app.wrongBook[qid] = {
          questionId: qid,
          paperId: value.paperId || "",
          number: value.number || "",
          type: value.type || "",
          stem: value.stem || "",
          userAnswer: value.userAnswer || "",
          correctAnswer: value.correctAnswer || "",
          wrongCount: value.wrongCount || 1,
          lastWrongAt: value.addedAt || new Date().toISOString(),
          status: value.status || "wrong",
        };
      });
      Object.entries(legacy.mastery || {}).forEach(([qid, value]) => {
        app.subjective[qid] = {
          questionId: qid,
          status: value,
          note: legacy.notes?.[qid] || "",
          updatedAt: new Date().toISOString(),
        };
      });
      saveRecords();
      saveWrongBook();
      saveSubjective();
      saveSession();
    } catch (error) {
      console.warn("旧版记录迁移失败", error);
    }
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
})();
