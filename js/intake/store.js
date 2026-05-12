/**
 * Intake store — all intake state in one place, wired to the app's
 * reactive Proxy-based state system.
 *
 * The store keeps intake-specific data on `state.intake` and exposes
 * action functions that drive the 5-stage pipeline.
 */

import { state, set, on } from "../state.js";
import { createSession, createMessage, createProgressSteps } from "./session.js";
import { classifyFiles, classifyIntent, hasGeometrySource } from "./classifier.js";
import { autoDetectInputs } from "./auto-detect.js";
import { generateQuestions, allRequiredFilled } from "./input-engine.js";
import { generatePlan } from "./plan-generator.js";
import { buildFirstResponse, buildAnswerSummary, buildFollowUpResponse, buildPlanIntro } from "./templates.js";
import { navigate } from "../router.js";

export function initIntakeStore() {
  if (!state.intake) {
    state.intake = {
      session: createSession(),
      isSubmitting: false,
      isTransitioned: false,
      pendingFiles: [],
      inputText: "",
    };
  }
}

function s() {
  return state.intake.session;
}

function update() {
  state.intake = { ...state.intake };
}

// ── Actions ──────────────────────────────────────────────────────────

export function setInputText(text) {
  // Mutate directly to avoid triggering a re-render on every keystroke.
  // The textarea already has the typed content; re-rendering would reset cursor.
  state.intake.inputText = text;
}

export function addPendingFiles(fileList) {
  const classified = classifyFiles(fileList);
  const next = [...state.intake.pendingFiles, ...classified];
  state.intake = { ...state.intake, pendingFiles: next };
}

export function removePendingFile(fileId) {
  const next = state.intake.pendingFiles.filter((f) => f.fileId !== fileId);
  state.intake = { ...state.intake, pendingFiles: next };
}

export function setQuickStart(text) {
  // Mutate directly — the caller sets the textarea value manually.
  state.intake.inputText = text;
}

export function submitInitialMessage(text, pendingFiles) {
  const session = createSession();
  session.status = "classifying_intent";
  session.userGoal = text;

  // Step 1: classify files
  session.files = pendingFiles.slice();
  const geoSource = hasGeometrySource(session.files);
  if (geoSource) session.knownInputs.geometry_source = true;

  // Step 2: classify intent
  session.workflow = classifyIntent(text, geoSource);

  // Step 3: auto-detect inputs
  const detected = autoDetectInputs(text);
  Object.assign(session.knownInputs, detected);

  // Step 4: generate questions
  const questions = generateQuestions(session.workflow, session.knownInputs);

  // Step 5: build messages
  const userMsg = createMessage("user", text, {
    files: session.files.length > 0 ? session.files : undefined,
  });
  session.messages.push(userMsg);

  // General question short-circuit: no intake flow needed
  if (session.workflow === "general_question") {
    const assistantMsg = createMessage("assistant",
      "I\u2019m a structural engineering assistant. I can help with project-related tasks like generating column layouts, parsing models, sizing members, and more. Try describing a specific structural task, or attach geometry files to get started.");
    session.messages.push(assistantMsg);
    session.status = "idle";

    state.intake = {
      ...state.intake,
      session,
      isTransitioned: true,
      isSubmitting: false,
      pendingFiles: [],
      inputText: "",
    };
    return;
  }

  const responseText = buildFirstResponse(session, questions);

  if (questions.length > 0) {
    const assistantMsg = createMessage("assistant", responseText, { questions });
    session.messages.push(assistantMsg);
    session.status = "asking_questions";
  } else {
    // Skip to plan
    const plan = generatePlan(session);
    session.plan = plan;
    const assistantMsg = createMessage("assistant", responseText, { plan });
    session.messages.push(assistantMsg);
    session.status = "ready_for_plan";
  }

  state.intake = {
    ...state.intake,
    session,
    isTransitioned: true,
    isSubmitting: false,
    pendingFiles: [],
    inputText: "",
  };
}

export function submitAnswers(answers) {
  const session = { ...s() };
  session.knownInputs = { ...session.knownInputs, ...answers };

  // Build user message showing answers
  const lastAssistant = session.messages.filter((m) => m.role === "assistant").pop();
  const questionMap = {};
  if (lastAssistant?.questions) {
    lastAssistant.questions.forEach((q) => { questionMap[q.id] = q; });
  }
  const summaryText = buildAnswerSummary(answers, questionMap);
  session.messages = [...session.messages, createMessage("user", summaryText)];

  // Check if we need more questions
  if (allRequiredFilled(session.workflow, session.knownInputs)) {
    const plan = generatePlan(session);
    session.plan = plan;
    const assistantMsg = createMessage("assistant", buildPlanIntro(), { plan });
    session.messages = [...session.messages, assistantMsg];
    session.status = "ready_for_plan";
  } else {
    const moreQuestions = generateQuestions(session.workflow, session.knownInputs);
    if (moreQuestions.length > 0) {
      const assistantMsg = createMessage("assistant", buildFollowUpResponse(), { questions: moreQuestions });
      session.messages = [...session.messages, assistantMsg];
      session.status = "asking_questions";
    } else {
      const plan = generatePlan(session);
      session.plan = plan;
      const assistantMsg = createMessage("assistant", buildPlanIntro(), { plan });
      session.messages = [...session.messages, assistantMsg];
      session.status = "ready_for_plan";
    }
  }

  state.intake = { ...state.intake, session };
}

export function confirmPlan() {
  const session = { ...s() };
  session.status = "running_analysis";

  const progressSteps = createProgressSteps(session);
  const assistantMsg = createMessage("assistant", "Starting analysis\u2026", { progress: progressSteps });
  session.messages = [...session.messages, assistantMsg];

  state.intake = { ...state.intake, session };

  runMockExecution(progressSteps);
}

export function submitFollowUp(text) {
  const session = { ...s() };
  session.messages = [...session.messages, createMessage("user", text)];
  session.status = "running_analysis";
  state.intake = { ...state.intake, session };
}

export function resetIntake() {
  state.intake = {
    session: createSession(),
    isSubmitting: false,
    isTransitioned: false,
    pendingFiles: [],
    inputText: "",
  };
}

export function openWorkspace() {
  const session = s();
  if (session.projectId) {
    navigate(`/p/${session.projectId}/overview`);
  } else {
    navigate("/p/8th-street/overview");
  }
}

// ── Mock execution (Stage 5) ─────────────────────────────────────────

function runMockExecution(steps) {
  let idx = 0;

  function advanceStep() {
    if (idx >= steps.length) {
      finishExecution();
      return;
    }

    steps[idx].status = "running";
    updateProgress(steps);

    const delay = 800 + Math.random() * 1200;
    setTimeout(() => {
      steps[idx].status = "done";

      if (idx === 0) steps[idx].detail = "Project created";
      if (steps[idx].step.startsWith("Parse")) steps[idx].detail = "Geometry extracted";
      if (steps[idx].step === "Build source model") steps[idx].detail = "Model built with 8 levels";
      if (steps[idx].step === "Extract structural interpretation") steps[idx].detail = "Detected 5 levels, 2 cores, 14 grids";
      if (steps[idx].step === "Generate scheme") steps[idx].detail = "3 candidate schemes generated";
      if (steps[idx].step === "Finalize workspace") steps[idx].detail = "Workspace ready";

      updateProgress(steps);
      idx += 1;
      advanceStep();
    }, delay);
  }

  advanceStep();
}

function updateProgress(steps) {
  const session = { ...s() };
  const lastMsg = session.messages[session.messages.length - 1];
  if (lastMsg?.progress) {
    lastMsg.progress = [...steps];
    session.messages = [...session.messages.slice(0, -1), { ...lastMsg }];
  }
  state.intake = { ...state.intake, session };
}

function finishExecution() {
  const session = { ...s() };
  session.status = "completed";
  session.projectId = `proj-${Date.now()}`;

  const completionMsg = createMessage("assistant", "Your project is ready.", {
    completion: true,
  });
  session.messages = [...session.messages, completionMsg];

  state.intake = { ...state.intake, session };
}
