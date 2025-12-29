// letters.js – debug timing + sound sequencing + beep-mute integration

// Speech timing/indicator thresholds. Keep in sync with the native
// LimeTunaSpeech constants so we can retune or delete the indicator in one go.
// Start gating is disabled on native; the silence gate is derived from the
// per-attempt rolling baseline + a deviation and capped by the native maximum.
// If the native timing payload includes overrides, we adopt them on the fly
// for the indicator.
const SPEECH_INDICATOR_THRESHOLDS = {
  rmsVoiceTriggerDb: -2.0, // First RMS level that counts as "speech started"
  rmsEndThresholdDb: 2.5,
  baselineRmsDb: null,
  computedEndThresholdDb: 2.5
};
const SILENCE_END_BASELINE_DELTA_PERCENT = 0.45;
const SILENCE_END_BASELINE_DELTA_DB_MIN = 2.0;
const NATIVE_SILENCE_END_THRESHOLD_DB_MAX = 2.5;

const ALL_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const MAX_ATTEMPTS_PER_LETTER = 2;
const CORRECT_SOUND_DURATION_MS = 2000; // correct.wav ~2s
const RMS_DISPLAY_INTERVAL_MS = 100;
const RMS_STALE_MS = 550;
const RMS_ROLLING_WINDOW_SAMPLES = 5;
const RMS_SHORT_WINDOW_MS = 350;
const SILENCE_BELOW_SUSTAIN_MS = 120;
const POST_SILENCE_MS = 1300;
const LISTENING_WATCHDOG_MS = 8000;
const NO_RMS_HINT_MS = 1500;

function computeSilenceEndThreshold(thresholds) {
  const endMax = thresholds && typeof thresholds.rmsEndThresholdDb === "number"
    ? thresholds.rmsEndThresholdDb
    : NATIVE_SILENCE_END_THRESHOLD_DB_MAX;
  const baseline =
    thresholds && typeof thresholds.baselineRmsDb === "number"
      ? thresholds.baselineRmsDb
      : null;
  if (baseline === null) {
    return endMax;
  }
  const delta = Math.max(
    SILENCE_END_BASELINE_DELTA_DB_MIN,
    Math.abs(baseline) * SILENCE_END_BASELINE_DELTA_PERCENT
  );
  return Math.min(endMax, baseline + delta);
}

let LETTER_SEQUENCE = [];
let currentIndex = 0;
let correctCount = 0;
let attemptCount = 0;
let recognizing = false;

let sttEnabled = false;
let sttFatalError = false;

let currentLetterEl;
let progressEl;
let statusEl;
let feedbackEl;
let finalScoreEl;
let backToHomeBtn;
let restartGameBtn;

let soundCorrectEl;
let soundWrongEl;
let soundWinEl;
let soundLoseEl;

// debug timing (to see where the delay is)
let lastListenStartTs = 0;
let currentAttemptTiming = null;
let currentThresholds = Object.assign({}, SPEECH_INDICATOR_THRESHOLDS);
let currentAttemptToken = 0;

let timingPanelEl;
let timingStageEl;
let timingSummaryEl;
let lastTimingRenderMs = 0;
let lastRmsRenderMs = 0;
let timingDisplayState = {
  stageText: "Timing idle",
  summaryText: "Timings will appear after you speak."
};
let timingIndicatorEl;
let postSilenceTimerId = null;
let rmsPanelEl;
let rmsNowEl;
let rmsMinMaxEl;
let rmsShortAvgEl;
let rmsSilenceStateEl;
let rmsScaleEl;
let speechDetectedForAttempt = false;
let rmsSeenThisAttempt = false;
let listeningWatchdogTimerId = null;
let noRmsHintTimerId = null;
const rmsDebugState = {
  timerId: null,
  active: false,
  lastDb: null,
  avgDb: null,
  minDb: null,
  maxDb: null,
  lastUpdateMs: 0,
  shortSamples: [],
  shortAvgDb: null,
  rollingSamples: [],
  rollingAvgDb: null
};
let postSilenceDeadlineMs = null;
let silenceBelowSinceMs = null;

function shuffleArray(arr) {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function forceStopNativeListening() {
  if (window.cordova && window.LimeTunaSpeech && typeof LimeTunaSpeech.stop === "function") {
    try {
      LimeTunaSpeech.stop();
    } catch (e) {
      console.warn("Failed to stop native listening (safe to ignore if idle):", e);
    }
  }
}

function parseErrorCode(err) {
  if (!err) return null;

  if (typeof err === "string") {
    try {
      const obj = JSON.parse(err);
      return obj.code || null;
    } catch (e) {
      if (err.indexOf("Class not found") !== -1) return "CLASS_NOT_FOUND";
      if (err.indexOf("Missing Command Error") !== -1) return "MISSING_COMMAND";
      return null;
    }
  }

  if (typeof err === "object") {
    return err.code || null;
  }

  return null;
}

function isHardSttErrorCode(code) {
  return (
    code === "PERMISSION_DENIED" ||
    code === "INSUFFICIENT_PERMISSIONS" ||
    code === "START_FAILED" ||
    code === "ALREADY_LISTENING" ||
    code === "CLASS_NOT_FOUND" ||
    code === "MISSING_COMMAND" ||
    code === "ENGINE_UNAVAILABLE" ||
    code === "ENGINE_CREATE_FAILED"
  );
}

// --- Audio helper ------------------------------------------------------------

function playSound(el, onEnded) {
  if (!el) {
    if (typeof onEnded === "function") onEnded();
    return;
  }

  try {
    el.muted = false;
    el.volume = 1.0;
    el.currentTime = 0;

    if (typeof onEnded === "function") {
      const handler = () => {
        el.removeEventListener("ended", handler);
        onEnded();
      };
      el.addEventListener("ended", handler);
    }

    const p = el.play();
    if (p && typeof p.then === "function") {
      p.catch((e) => {
        console.warn("sound play error:", e);
        if (typeof onEnded === "function") onEnded();
      });
    }
  } catch (e) {
    console.warn("sound play exception:", e);
    if (typeof onEnded === "function") onEnded();
  }
}

// --- Game setup --------------------------------------------------------------

function initLettersGame() {
  currentLetterEl = document.getElementById("currentLetter");
  progressEl = document.getElementById("lettersProgress");
  statusEl = document.getElementById("lettersStatus");
  feedbackEl = document.getElementById("lettersFeedback");
  finalScoreEl = document.getElementById("finalScore");
  backToHomeBtn = document.getElementById("backToHomeBtn");
  restartGameBtn = document.getElementById("restartGameBtn");
  timingPanelEl = document.getElementById("lettersTiming");
  timingStageEl = document.getElementById("timingStage");
  timingSummaryEl = document.getElementById("timingSummary");
  timingIndicatorEl = document.getElementById("timingIndicator");
  rmsPanelEl = document.getElementById("lettersRmsPanel");
  rmsNowEl = document.getElementById("rmsNow");
  rmsMinMaxEl = document.getElementById("rmsMinMax");
  rmsShortAvgEl = document.getElementById("rmsShortAvg");
  rmsSilenceStateEl = document.getElementById("rmsSilenceState");
  rmsScaleEl = document.getElementById("rmsScaleNote");

  soundCorrectEl = document.getElementById("soundCorrect");
  soundWrongEl = document.getElementById("soundWrong");
  soundWinEl = document.getElementById("soundWin");
  soundLoseEl = document.getElementById("soundLose");

  [soundCorrectEl, soundWrongEl, soundWinEl, soundLoseEl].forEach((el) => {
    if (el) {
      el.muted = false;
      el.volume = 1.0;
    }
  });

  if (!currentLetterEl || !progressEl || !statusEl || !feedbackEl || !finalScoreEl) {
    console.error("Letters screen elements not found.");
    return;
  }

  // 3) Stop the weird initial letter flash: clear any placeholder
  currentLetterEl.textContent = "";
  progressEl.textContent = "";

  if (backToHomeBtn) {
    backToHomeBtn.addEventListener("click", () => {
      if (window.cordova && window.LimeTunaSpeech) {
        if (LimeTunaSpeech.setBeepsMuted) {
          LimeTunaSpeech.setBeepsMuted(false);
        }
        if (LimeTunaSpeech.setKeepScreenOn) {
          LimeTunaSpeech.setKeepScreenOn(false);
        }
      }
      window.location.href = "index.html";
    });
  }

  if (restartGameBtn) {
    restartGameBtn.addEventListener("click", () => {
      startNewGame();
    });
  }

  startNewGame();
}

function formatMs(val) {
  if (val === null || val === undefined || isNaN(val)) return "n/a";
  return `${Math.round(val)} ms`;
}

function updateTimingPanel(partial, force) {
  if (!timingStageEl || !timingSummaryEl || !timingPanelEl) return;

  timingDisplayState = Object.assign({}, timingDisplayState, partial || {});
  const now = performance.now();
  const shouldUpdate = force || now - lastTimingRenderMs > 180;
  if (!shouldUpdate) {
    return;
  }

  timingStageEl.textContent = timingDisplayState.stageText || "";
  timingSummaryEl.textContent = timingDisplayState.summaryText || "";
  lastTimingRenderMs = now;
}

function clearPostSilenceTimer() {
  if (postSilenceTimerId) {
    clearTimeout(postSilenceTimerId);
    postSilenceTimerId = null;
  }
  postSilenceDeadlineMs = null;
}

function setTimingIndicator(state) {
  if (!timingIndicatorEl) return;
  const states = ["timing-idle", "timing-speech", "timing-silence", "timing-processing"];
  timingIndicatorEl.classList.remove(...states);

  let className = "timing-idle";
  if (state === "speech") className = "timing-speech";
  else if (state === "silence") className = "timing-silence";
  else if (state === "processing") className = "timing-processing";

  timingIndicatorEl.classList.add(className);
}

function resetTimingIndicator() {
  clearPostSilenceTimer();
  setTimingIndicator("idle");
  speechDetectedForAttempt = false;
  silenceBelowSinceMs = null;
}

// Temporary RMS debug helpers while tuning speech thresholds.
function resetRmsDebugState() {
  if (rmsDebugState.timerId) {
    clearInterval(rmsDebugState.timerId);
    rmsDebugState.timerId = null;
  }
  rmsDebugState.active = false;
  rmsDebugState.lastDb = null;
  rmsDebugState.avgDb = null;
  rmsDebugState.minDb = null;
  rmsDebugState.maxDb = null;
  rmsDebugState.lastUpdateMs = 0;
  rmsDebugState.shortSamples = [];
  rmsDebugState.shortAvgDb = null;
  rmsDebugState.rollingSamples = [];
  rmsDebugState.rollingAvgDb = null;
  postSilenceDeadlineMs = null;
  silenceBelowSinceMs = null;
  renderRmsPanel(true);
}

function startRmsDebugSession() {
  resetRmsDebugState();
  rmsDebugState.active = true;
  if (rmsPanelEl) {
    rmsPanelEl.classList.add("rms-active");
    rmsPanelEl.classList.remove("rms-idle");
  }
  rmsDebugState.timerId = setInterval(() => renderRmsPanel(), RMS_DISPLAY_INTERVAL_MS);
  renderRmsPanel(true);
}

function stopRmsDebugSession() {
  if (rmsDebugState.timerId) {
    clearInterval(rmsDebugState.timerId);
    rmsDebugState.timerId = null;
  }
  rmsDebugState.active = false;
  if (rmsPanelEl) {
    rmsPanelEl.classList.add("rms-idle");
    rmsPanelEl.classList.remove("rms-active");
  }
  renderRmsPanel(true);
}

function handleNativeRmsUpdate(payload) {
  if (!payload || typeof payload.rms_db !== "number") return;
  clearNoRmsHintTimer();
  const now = performance.now();
  rmsDebugState.lastDb = payload.rms_db;
  rmsSeenThisAttempt = true;

  if (typeof payload.avg_rms_db === "number") {
    rmsDebugState.avgDb = payload.avg_rms_db;
  }

  rmsDebugState.rollingSamples.push(payload.rms_db);
  if (rmsDebugState.rollingSamples.length > RMS_ROLLING_WINDOW_SAMPLES) {
    rmsDebugState.rollingSamples.shift();
  }
  if (rmsDebugState.rollingSamples.length) {
    const rollingSum = rmsDebugState.rollingSamples.reduce((acc, val) => acc + val, 0);
    rmsDebugState.rollingAvgDb = rollingSum / rmsDebugState.rollingSamples.length;
  }

  rmsDebugState.shortSamples.push({ ts: now, db: payload.rms_db });
  while (rmsDebugState.shortSamples.length && now - rmsDebugState.shortSamples[0].ts > RMS_SHORT_WINDOW_MS) {
    rmsDebugState.shortSamples.shift();
  }
  if (rmsDebugState.shortSamples.length) {
    const sum = rmsDebugState.shortSamples.reduce((acc, item) => acc + item.db, 0);
    rmsDebugState.shortAvgDb = sum / rmsDebugState.shortSamples.length;
  }
  const minCandidate = typeof payload.min_rms_db === "number" ? payload.min_rms_db : rmsDebugState.minDb;
  const maxCandidate = typeof payload.max_rms_db === "number" ? payload.max_rms_db : rmsDebugState.maxDb;

  if (typeof minCandidate === "number") {
    rmsDebugState.minDb = typeof rmsDebugState.minDb === "number" ? Math.min(rmsDebugState.minDb, minCandidate) : minCandidate;
  } else {
    rmsDebugState.minDb = typeof rmsDebugState.lastDb === "number" ? rmsDebugState.lastDb : rmsDebugState.minDb;
  }

  if (typeof maxCandidate === "number") {
    rmsDebugState.maxDb = typeof rmsDebugState.maxDb === "number" ? Math.max(rmsDebugState.maxDb, maxCandidate) : maxCandidate;
  } else {
    rmsDebugState.maxDb = typeof rmsDebugState.lastDb === "number" ? rmsDebugState.lastDb : rmsDebugState.maxDb;
  }

  const levelForLogic =
    typeof rmsDebugState.rollingAvgDb === "number" ? rmsDebugState.rollingAvgDb : payload.rms_db;

  if (
    recognizing &&
    !speechDetectedForAttempt &&
    typeof currentThresholds.rmsVoiceTriggerDb === "number" &&
    levelForLogic >= currentThresholds.rmsVoiceTriggerDb
  ) {
    speechDetectedForAttempt = true;
    setTimingIndicator("speech");
    silenceBelowSinceMs = null;
  }

  const silenceThreshold =
    typeof currentThresholds.computedEndThresholdDb === "number"
      ? currentThresholds.computedEndThresholdDb
      : currentThresholds.rmsEndThresholdDb;
  const isBelowSilence = recognizing && typeof silenceThreshold === "number" && levelForLogic < silenceThreshold;
  if (!recognizing) {
    silenceBelowSinceMs = null;
  } else if (isBelowSilence) {
    if (silenceBelowSinceMs === null) {
      silenceBelowSinceMs = now;
    }
    const sustainedBelow = now - silenceBelowSinceMs >= SILENCE_BELOW_SUSTAIN_MS;
    if (sustainedBelow && speechDetectedForAttempt && !postSilenceTimerId && !postSilenceDeadlineMs) {
      enterPostSilenceWindow();
    }
  } else {
    silenceBelowSinceMs = null;
  }

  rmsDebugState.lastUpdateMs = now;
}

function renderRmsPanel(force) {
  if (!rmsPanelEl || !rmsNowEl || !rmsMinMaxEl) return;
  const now = performance.now();
  const isFresh = rmsDebugState.lastUpdateMs && now - rmsDebugState.lastUpdateMs < RMS_STALE_MS;
  const isActive = rmsDebugState.active && isFresh;
  const nowText =
    typeof rmsDebugState.lastDb === "number" ? `${rmsDebugState.lastDb.toFixed(1)} dB` : "—";
  const avgText =
    typeof rmsDebugState.avgDb === "number" ? ` (avg ${rmsDebugState.avgDb.toFixed(1)} dB)` : "";
  const shortAvgText =
    typeof rmsDebugState.rollingAvgDb === "number"
      ? `${rmsDebugState.rollingAvgDb.toFixed(1)} dB (5-sample rolling)`
      : typeof rmsDebugState.shortAvgDb === "number"
      ? `${rmsDebugState.shortAvgDb.toFixed(1)} dB (short)`
      : "—";
  const minText =
    typeof rmsDebugState.minDb === "number" ? `${rmsDebugState.minDb.toFixed(1)} dB` : "—";
  const maxText =
    typeof rmsDebugState.maxDb === "number" ? `${rmsDebugState.maxDb.toFixed(1)} dB` : "—";
  let silenceText = "Silence window: idle";
  if (postSilenceTimerId || postSilenceDeadlineMs) {
    const remaining = Math.max(0, (postSilenceDeadlineMs || now) - now);
    silenceText = `Silence window: waiting (~${Math.round(remaining)} ms to commit)`;
  }
  if (timingIndicatorEl && timingIndicatorEl.classList.contains("timing-processing")) {
    silenceText = "Silence window: processing";
  }

  rmsPanelEl.classList.toggle("rms-active", !!isActive);
  rmsPanelEl.classList.toggle("rms-idle", !isActive);

  if (!force && now - lastRmsRenderMs < RMS_DISPLAY_INTERVAL_MS) {
    return;
  }

  rmsNowEl.textContent = `RMS now: ${nowText}${avgText}`;
  rmsMinMaxEl.textContent = `Min/Max: ${minText} / ${maxText}`;
  if (rmsShortAvgEl) {
    rmsShortAvgEl.textContent = `Short avg: ${shortAvgText}`;
  }
  if (rmsSilenceStateEl) {
    rmsSilenceStateEl.textContent = silenceText;
  }
  if (rmsScaleEl) {
    const silenceGate = typeof currentThresholds.computedEndThresholdDb === "number"
      ? currentThresholds.computedEndThresholdDb.toFixed(2)
      : currentThresholds.rmsEndThresholdDb;
    rmsScaleEl.textContent = `Scale: approx −2…10 dB · Start gate disabled; silence gate ~${silenceGate} dB (baseline-adaptive)`;
  }
  lastRmsRenderMs = now;
}

function enterPostSilenceWindow() {
  clearPostSilenceTimer();
  setTimingIndicator("silence");
  postSilenceDeadlineMs = performance.now() + POST_SILENCE_MS;
  postSilenceTimerId = setTimeout(() => {
    setTimingIndicator("processing");
    postSilenceDeadlineMs = null;
    postSilenceTimerId = null;
  }, POST_SILENCE_MS);
}

function describeStage(label, timestamp, originTs) {
  if (!timestamp || !originTs) return `${label} …`;
  const delta = timestamp - originTs;
  return `${label} ✓ (+${Math.round(delta)} ms)`;
}

function buildStageLines(timingPayload) {
  const thresholds = timingPayload && timingPayload.native_thresholds
    ? {
        rmsVoiceTriggerDb:
          typeof timingPayload.native_thresholds.rms_voice_trigger_db === "number"
            ? timingPayload.native_thresholds.rms_voice_trigger_db
            : currentThresholds.rmsVoiceTriggerDb,
        rmsEndThresholdDb:
          typeof timingPayload.native_thresholds.rms_end_threshold_db === "number"
            ? timingPayload.native_thresholds.rms_end_threshold_db
            : currentThresholds.rmsEndThresholdDb,
        baselineRmsDb:
          typeof timingPayload.native_thresholds.baseline_rms_db === "number"
            ? timingPayload.native_thresholds.baseline_rms_db
            : currentThresholds.baselineRmsDb
      }
    : currentThresholds;
  const rmsLabelParts = [];
  if (thresholds.rmsVoiceTriggerDb !== undefined && thresholds.rmsVoiceTriggerDb !== null) {
    rmsLabelParts.push(`>${thresholds.rmsVoiceTriggerDb} dB RMS`);
  }
  const computedEnd = computeSilenceEndThreshold(thresholds);
  rmsLabelParts.push(
    `start gate disabled; silence gate ~${computedEnd.toFixed(2)} dB (baseline-adaptive, cap ${NATIVE_SILENCE_END_THRESHOLD_DB_MAX} dB)`
  );
  const rmsLabel = ` (${rmsLabelParts.join(" · ")})`;
  if (!timingPayload || !timingPayload.native_raw) {
    return [
      "Starting…",
      "Waiting for engine ready…",
      `Detected speech${rmsLabel}…`,
      "Engine processing…",
      "Result received…"
    ];
  }
  const raw = timingPayload.native_raw;
  const anchor = raw.native_received_ms || raw.native_startListening_ms || null;
  return [
    describeStage("Starting…", raw.native_startListening_ms, anchor || raw.native_received_ms),
    describeStage("Waiting for engine ready…", raw.native_readyForSpeech_ms, anchor || raw.native_startListening_ms),
    describeStage(
      `Detected speech${rmsLabel}…`,
      raw.native_beginningOfSpeech_ms || raw.native_firstRmsAboveThreshold_ms,
      raw.native_readyForSpeech_ms || anchor || raw.native_startListening_ms
    ),
    describeStage("Engine processing…", raw.native_endOfSpeech_ms, raw.native_beginningOfSpeech_ms || raw.native_firstRmsAboveThreshold_ms || anchor),
    describeStage("Result received…", raw.native_results_ms || raw.native_error_ms || raw.native_callback_sent_ms, anchor)
  ];
}

function buildEngineBreakdown(nativeDurations) {
  if (!nativeDurations) {
    return { text: "Engine breakdown unavailable.", totalMs: null };
  }

  const components = [];
  let totalMs = 0;
  let count = 0;

  const addComponent = (label, key) => {
    if (nativeDurations[key] !== undefined) {
      const val = nativeDurations[key];
      components.push(`${label}: ${formatMs(val)}`);
      totalMs += val;
      count++;
    }
  };

  addComponent("Queue→native", "d_queue_native_ms");
  addComponent("Ready for speech", "d_engine_ready_ms");
  addComponent("Speech→engine", "d_user_speech_to_engine_ms");
  addComponent("Engine processing", "d_engine_processing_ms");
  addComponent("Normalize", "d_normalize_ms");

  if (count > 0) {
    components.push(`Approx engine total: ${formatMs(totalMs)}`);
  }

  const text = components.length ? `Engine breakdown: ${components.join(" · ")}` : "Engine breakdown unavailable.";
  return { text, totalMs: count > 0 ? totalMs : null };
}

function buildTimingSummary(nativeDurations, jsDurations) {
  const parts = [];

  const engineBreakdown = buildEngineBreakdown(nativeDurations);
  if (engineBreakdown && engineBreakdown.text) {
    parts.push(engineBreakdown.text);
  }

  if (jsDurations && jsDurations.d_total_js !== undefined) {
    parts.push(`JS total: ${formatMs(jsDurations.d_total_js)}`);
  }
  if (jsDurations && jsDurations.d_audio_start_ms !== undefined) {
    parts.push(`Audio start after: ${formatMs(jsDurations.d_audio_start_ms)}`);
  }

  if (parts.length === 0) {
    return "Awaiting timing data…";
  }
  return parts.join(" · ");
}

function recordJsTiming(key) {
  if (!currentAttemptTiming) return;
  currentAttemptTiming[key] = performance.now();
}

function updateCurrentThresholds(timingPayload) {
  if (!timingPayload || !timingPayload.native_thresholds) return;

  const { rms_voice_trigger_db, rms_end_threshold_db, baseline_rms_db } = timingPayload.native_thresholds;
  if (typeof rms_voice_trigger_db === "number") {
    currentThresholds.rmsVoiceTriggerDb = rms_voice_trigger_db;
  }
  if (typeof rms_end_threshold_db === "number") {
    currentThresholds.rmsEndThresholdDb = rms_end_threshold_db;
  }
  if (typeof baseline_rms_db === "number") {
    currentThresholds.baselineRmsDb = baseline_rms_db;
  } else {
    currentThresholds.baselineRmsDb = null;
  }
  currentThresholds.computedEndThresholdDb = computeSilenceEndThreshold({
    rmsEndThresholdDb: currentThresholds.rmsEndThresholdDb,
    baselineRmsDb: currentThresholds.baselineRmsDb
  });
}

function refreshTimingSummaryAfterAudio() {
  if (!currentAttemptTiming || !currentAttemptTiming.lastTimingPayload) return;

  const nativeDurations = currentAttemptTiming.lastTimingPayload.native_durations || null;
  const jsDurations = {};
  if (currentAttemptTiming.js_start_ms !== undefined) {
    if (currentAttemptTiming.js_got_result_ms !== undefined) {
      jsDurations.d_total_js = currentAttemptTiming.js_got_result_ms - currentAttemptTiming.js_start_ms;
    }
    if (currentAttemptTiming.js_audio_start_ms !== undefined) {
      jsDurations.d_audio_start_ms = currentAttemptTiming.js_audio_start_ms - currentAttemptTiming.js_start_ms;
    }
  }

  updateTimingPanel(
    {
      summaryText: buildTimingSummary(nativeDurations, jsDurations)
    },
    true
  );
}

function clearListeningWatchdog() {
  if (listeningWatchdogTimerId) {
    clearTimeout(listeningWatchdogTimerId);
    listeningWatchdogTimerId = null;
  }
}

function handleNoSpeechDetected(expectedUpper) {
  clearNoRmsHintTimer();
  recognizing = false;
  speechDetectedForAttempt = false;
  stopRmsDebugSession();
  clearPostSilenceTimer();
  clearListeningWatchdog();
  forceStopNativeListening();

  const attemptNumber = attemptCount + 1;
  const attemptLabel = expectedUpper ? `${expectedUpper} attempt ${attemptNumber}/${MAX_ATTEMPTS_PER_LETTER}` : `Attempt ${attemptNumber}/${MAX_ATTEMPTS_PER_LETTER}`;
  const thresholdText =
    typeof currentThresholds.rmsVoiceTriggerDb === "number"
      ? ` (speech trigger > ${currentThresholds.rmsVoiceTriggerDb} dB RMS)`
      : "";
  const summaryText = rmsSeenThisAttempt
    ? `No speech above the trigger${thresholdText} was detected before timing out.`
    : "No RMS levels were seen before timing out. Please check microphone permission or availability.";
  const statusLines = [
    `No microphone input detected for ${attemptLabel}.`,
    rmsSeenThisAttempt
      ? "We heard very low audio, but nothing crossed the speech trigger. Try moving closer to the mic or speaking louder."
      : "We did not receive microphone levels. Please check microphone permissions or your device's input.",
    "No RMS seen before timeout; retrying this letter…"
  ];
  if (expectedUpper) {
    statusLines.unshift(`Listening for "${expectedUpper}" timed out.`);
  }

  statusEl.textContent = statusLines.join("\n");
  updateTimingPanel(
    {
      stageText: `No speech detected for ${attemptLabel}; retrying…`,
      summaryText
    },
    true
  );
  resetTimingIndicator();
  retryOrAdvance();
}

function startListeningWatchdog(expectedUpper) {
  clearListeningWatchdog();
  listeningWatchdogTimerId = setTimeout(() => {
    if (!recognizing) return;
    handleNoSpeechDetected(expectedUpper);
  }, LISTENING_WATCHDOG_MS);
}

function clearNoRmsHintTimer() {
  if (noRmsHintTimerId) {
    clearTimeout(noRmsHintTimerId);
    noRmsHintTimerId = null;
  }
}

function startNoRmsHintTimer(attemptLabel) {
  clearNoRmsHintTimer();
  noRmsHintTimerId = setTimeout(() => {
    if (!recognizing || rmsSeenThisAttempt) return;
    const hintLines = [
      `Still waiting for microphone levels for ${attemptLabel}…`,
      "If prompted, allow microphone access or ensure your mic is connected/unmuted."
    ];
    const summaryText = `No RMS seen after ~${NO_RMS_HINT_MS} ms; waiting for microphone levels before the main timeout.`;
    statusEl.textContent = [statusEl.textContent, hintLines.join("\n")].filter(Boolean).join("\n");
    updateTimingPanel(
      {
        stageText: "Waiting for microphone levels…",
        summaryText
      },
      true
    );
    console.warn("[letters] rms hint timer fired without audio levels");
  }, NO_RMS_HINT_MS);
}

function startNewGame() {
  LETTER_SEQUENCE = shuffleArray(ALL_LETTERS).slice(0, 10);
  currentIndex = 0;
  correctCount = 0;
  attemptCount = 0;
  recognizing = false;
  sttFatalError = false;
  currentThresholds = Object.assign({}, SPEECH_INDICATOR_THRESHOLDS);
  clearListeningWatchdog();
  updateTimingPanel(
    {
      stageText: "Timing idle",
      summaryText: "Timings will appear after you speak."
    },
    true
  );
  resetTimingIndicator();
  resetRmsDebugState();

  finalScoreEl.classList.add("hidden");
  if (restartGameBtn) restartGameBtn.classList.add("hidden");
  feedbackEl.textContent = "";
  feedbackEl.style.color = "";

  updateUIForCurrentLetter();

  // Keep screen awake & mute system beeps
  if (window.cordova && window.LimeTunaSpeech) {
    if (LimeTunaSpeech.setKeepScreenOn) {
      LimeTunaSpeech.setKeepScreenOn(true);
    }
    if (LimeTunaSpeech.setBeepsMuted) {
      LimeTunaSpeech.setBeepsMuted(true);
    }
  }

  if (window.LimeTunaSpeech && window.cordova) {
    statusEl.textContent = "Preparing microphone…";

    LimeTunaSpeech.init(
      {
        language: "en-US"
      },
      function () {
        console.log("LimeTunaSpeech.init success");
        sttEnabled = true;
        statusEl.textContent = "Speech ready. Say the letter when you're ready.";
        startListeningForCurrentLetter();
      },
      function (err) {
        if (window.cordova && window.LimeTunaSpeech) {
          if (LimeTunaSpeech.setKeepScreenOn) {
            LimeTunaSpeech.setKeepScreenOn(false);
          }
          if (LimeTunaSpeech.setBeepsMuted) {
            LimeTunaSpeech.setBeepsMuted(false);
          }
        }

        sttEnabled = false;
        sttFatalError = true;

        console.error("LimeTunaSpeech.init error:", err);
        try {
          statusEl.textContent = "Init error: " + JSON.stringify(err);
        } catch (e) {
          statusEl.textContent = "Init error (raw): " + String(err);
        }
      }
    );
  } else {
    sttEnabled = false;
    if (window.LimeTunaSpeech) {
      if (LimeTunaSpeech.setKeepScreenOn) {
        LimeTunaSpeech.setKeepScreenOn(false);
      }
      if (LimeTunaSpeech.setBeepsMuted) {
        LimeTunaSpeech.setBeepsMuted(false);
      }
    }
    statusEl.textContent = "Speech not available in this environment.";
  }
}

// --- UI update ---------------------------------------------------------------

function updateUIForCurrentLetter() {
  attemptCount = 0;
  resetTimingIndicator();

  const total = LETTER_SEQUENCE.length;
  const displayIndex = Math.min(currentIndex + 1, total);

  const letter = LETTER_SEQUENCE[currentIndex] || "";
  currentLetterEl.textContent = letter;
  progressEl.textContent = `${displayIndex} / ${total}`;
  feedbackEl.textContent = "";
  feedbackEl.style.color = "";
}

// --- Speech handling ---------------------------------------------------------

function startListeningForCurrentLetter() {
  if (!sttEnabled || sttFatalError) {
    console.warn("STT disabled or fatal; not listening.");
    statusEl.textContent = "Speech engine not available.";
    resetTimingIndicator();
    return;
  }

  if (recognizing) {
    console.log("Already recognizing; ignoring extra start.");
    return;
  }

  const expected = LETTER_SEQUENCE[currentIndex];
  if (!expected) {
    console.warn("No expected letter at index", currentIndex);
    return;
  }

  // Defensive: stop any lingering native session before starting a new attempt.
  forceStopNativeListening();
  clearNoRmsHintTimer();

  recognizing = true;
  const attemptToken = ++currentAttemptToken;
  const attemptNumber = attemptCount + 1;
  const attemptLabel = `${expected.toUpperCase()} attempt ${attemptNumber}/${MAX_ATTEMPTS_PER_LETTER}`;
  lastListenStartTs = performance.now();
  currentAttemptTiming = {
    js_start_ms: lastListenStartTs,
    attemptToken,
    expectedUpper: expected.toUpperCase()
  };
  const renderNativeReady = (payload) => {
    const detail = payload && payload.message ? ` (${payload.message})` : "";
    const readyLines = [
      `Listening for ${attemptLabel}.`,
      `Engine ready${detail}; waiting for speech…`
    ];
    statusEl.textContent = readyLines.join("\n");
    updateTimingPanel(
      {
        stageText: "Engine ready; waiting for speech…",
        summaryText: `Engine reported ready for ${attemptLabel}.`
      },
      true
    );
    console.log("[letters] native ready callback", { attemptToken, payload });
  };
  speechDetectedForAttempt = false;
  rmsSeenThisAttempt = false;
  clearPostSilenceTimer();
  startRmsDebugSession();
  startListeningWatchdog(expected.toUpperCase());
  startNoRmsHintTimer(attemptLabel);
  statusEl.textContent = `Listening for ${attemptLabel} (waiting for Android speech engine)…`;
  console.log("[letters] stage=startListening", {
    expected,
    attemptToken,
    attemptNumber,
    js_start_ms: lastListenStartTs
  });
  updateTimingPanel(
    {
      stageText: "Waiting for engine ready…",
      summaryText: `Start request sent to native speech engine for ${attemptLabel}…`
    },
    true
  );

  try {
    LimeTunaSpeech.startLetter(
      expected,
      function (result) {
        if (result && result.type === "ready") {
          renderNativeReady(result);
          return;
        }
        if (attemptToken !== currentAttemptToken) {
          console.warn("[letters] stale result ignored", { attemptToken, currentAttemptToken, result });
          return;
        }
        clearListeningWatchdog();
        clearNoRmsHintTimer();
        const resultArrivalTs = performance.now();
        const engineMs = resultArrivalTs - lastListenStartTs;
        recordJsTiming("js_got_result_ms");
        enterPostSilenceWindow();
        stopRmsDebugSession();
        speechDetectedForAttempt = false;

        recognizing = false;

        const mapStart = performance.now();

        const rawText = result && result.text;
        const normalized = result && result.normalizedLetter;
        const expectedUpper = expected.toUpperCase();
        const timingPayload = result && result.timing;

        let isCorrect = false;
        if (normalized && normalized === expectedUpper) {
          isCorrect = true;
        }

        const mapEnd = performance.now();
        const mapMs = mapEnd - mapStart;
        recordJsTiming("js_decision_ms");
        if (currentAttemptTiming) {
          currentAttemptTiming.lastTimingPayload = timingPayload;
        }
        updateCurrentThresholds(timingPayload);

        const nativeDurations = timingPayload && timingPayload.native_durations ? timingPayload.native_durations : null;
        const jsDurations = {};
        if (currentAttemptTiming && currentAttemptTiming.js_start_ms !== undefined) {
          jsDurations.d_total_js = resultArrivalTs - currentAttemptTiming.js_start_ms;
        } else {
          jsDurations.d_total_js = engineMs;
        }
        if (currentAttemptTiming && currentAttemptTiming.js_start_ms !== undefined && currentAttemptTiming.js_decision_ms !== undefined) {
          jsDurations.d_decision_ms = currentAttemptTiming.js_decision_ms - currentAttemptTiming.js_start_ms;
        }
        if (currentAttemptTiming && currentAttemptTiming.js_start_ms !== undefined && currentAttemptTiming.js_audio_start_ms !== undefined) {
          jsDurations.d_audio_start_ms = currentAttemptTiming.js_audio_start_ms - currentAttemptTiming.js_start_ms;
        }

        const stageLines = buildStageLines(timingPayload);
        const stageText = stageLines.join(" · ");
        const summaryText = buildTimingSummary(nativeDurations, jsDurations);
        const engineBreakdown = buildEngineBreakdown(nativeDurations);
        const engineBreakdownText = engineBreakdown.text || "Engine breakdown unavailable.";

        const statusLines = [
          `Engine response (${attemptLabel}): ~${engineMs.toFixed(0)} ms (JS handling ~${mapMs.toFixed(1)} ms).`,
          `Heard: "${rawText || ""}" → "${normalized || ""}" (expected "${expectedUpper}")`,
          engineBreakdownText,
          `Playing ${isCorrect ? "correct" : "wrong"} sound…`,
          `Timings: ${summaryText}`
        ].filter(Boolean);

        statusEl.textContent = statusLines.join("\n");

        console.log("[letters] result received", {
          attemptToken,
          engineMs,
          mapMs,
          result,
          expected: expectedUpper,
          timing: timingPayload,
          jsDurations
        });
        updateTimingPanel(
          {
            stageText,
            summaryText
          },
          true
        );

        if (isCorrect) {
          handleCorrect();
        } else {
          handleIncorrect();
        }
      },
      function (err) {
        if (err && err.type === "ready") {
          renderNativeReady(err);
          return;
        }
        if (attemptToken !== currentAttemptToken) {
          console.warn("[letters] stale error ignored", { attemptToken, currentAttemptToken, err });
          return;
        }
        clearListeningWatchdog();
        clearNoRmsHintTimer();
        recognizing = false;

        const hadSpeechDetection = speechDetectedForAttempt;
        const sawAnyRms = rmsSeenThisAttempt;
        const now = performance.now();
        const engineMs = now - lastListenStartTs;
        recordJsTiming("js_got_result_ms");
        enterPostSilenceWindow();
        stopRmsDebugSession();
        speechDetectedForAttempt = false;

        const code = parseErrorCode(err);
        console.error("LimeTunaSpeech.startLetter error:", err, "code=", code);
        const timingPayload = err && err.timing ? err.timing : null;
        if (currentAttemptTiming) {
          currentAttemptTiming.lastTimingPayload = timingPayload;
        }
        updateCurrentThresholds(timingPayload);
        const nativeDurations = timingPayload && timingPayload.native_durations ? timingPayload.native_durations : null;
        const jsDurations = {};
        if (currentAttemptTiming && currentAttemptTiming.js_start_ms !== undefined) {
          jsDurations.d_total_js = now - currentAttemptTiming.js_start_ms;
        } else {
          jsDurations.d_total_js = engineMs;
        }
        const stageLines = buildStageLines(timingPayload);
        const summaryText = buildTimingSummary(nativeDurations, jsDurations);
        const engineBreakdown = buildEngineBreakdown(nativeDurations);
        const engineBreakdownText = engineBreakdown.text || "Engine breakdown unavailable.";
        console.log("[letters] stage=error", {
          attemptToken,
          code,
          timing: timingPayload,
          nativeDurations,
          jsDurations
        });
        updateTimingPanel(
          {
            stageText: stageLines.join(" · "),
            summaryText
          },
          true
        );
        resetTimingIndicator();

        if (code === "NO_MATCH") {
          const lines = [`No match heard for ${attemptLabel} (~${engineMs.toFixed(0)} ms).`];
          if (!sawAnyRms) {
            lines.push(
              "We never received microphone levels from the speech engine. Check mic permissions or your device input and try again.",
              "Retrying this letter without playing the wrong-answer sound…",
              engineBreakdownText,
              `Timings: ${summaryText}`
            );
            statusEl.textContent = lines.join("\n");
            retryOrAdvance();
            return;
          }
          if (hadSpeechDetection) {
            lines.push("We detected speech but the engine could not transcribe a letter. Counting as incorrect.");
          } else {
            lines.push("We heard quiet audio, but nothing crossed the speech trigger. Try speaking louder or closer to the mic.");
          }
          lines.push(engineBreakdownText, `Timings: ${summaryText}`);
          statusEl.textContent = lines.join("\n");
          handleIncorrect();
          return;
        }

        if (isHardSttErrorCode(code)) {
          sttFatalError = true;
          sttEnabled = false;
          statusEl.textContent = [
            `Engine error after ~${engineMs.toFixed(0)} ms (code ${code || "unknown"}).`,
            engineBreakdownText,
            "Speech engine error. Letters will show without listening.",
            `Timings: ${summaryText}`
          ].join("\n");

          // Continue the game flow even when STT is disabled so the UI can finish updating.
          advanceToNextLetter({ skipListening: true });
          return;
        }

        statusEl.textContent = [
          `Soft error (${attemptLabel}) after ~${engineMs.toFixed(0)} ms (error ${code || "unknown"}).`,
          engineBreakdownText,
          "Retrying this letter…",
          `Timings: ${summaryText}`
        ].join("\n");

        retryOrAdvance();
      },
      function (payload) {
        handleNativeRmsUpdate(payload);
        if (payload && payload.type === "ready") {
          renderNativeReady(payload);
        }
      }
    );
  } catch (err) {
    console.error("LimeTunaSpeech.startLetter threw synchronously", err);
    clearListeningWatchdog();
    clearNoRmsHintTimer();
    recognizing = false;
    stopRmsDebugSession();
    resetTimingIndicator();
    statusEl.textContent = [
      `Start failed for ${attemptLabel} (synchronous exception).`,
      err && err.message ? err.message : String(err),
      "Retrying this letter…"
    ].join("\n");
    updateTimingPanel(
      {
        stageText: "Start request failed before reaching engine.",
        summaryText: "startLetter threw synchronously; will retry."
      },
      true
    );
    retryOrAdvance();
  }
}

function handleCorrect() {
  const isLast = currentIndex === LETTER_SEQUENCE.length - 1;

  feedbackEl.textContent = "✓ Correct!";
  feedbackEl.style.color = "#2e7d32";
  statusEl.textContent += "\nPlaying correct sound…";

  correctCount++;

  // 1) Give correct.wav a fixed 2s window, no extra hanging,
  // and no overlap with win sound (win plays after endGame).
  recordJsTiming("js_audio_start_ms");
  refreshTimingSummaryAfterAudio();
  playSound(soundCorrectEl);
  setTimeout(() => {
    advanceToNextLetter();
  }, CORRECT_SOUND_DURATION_MS);
}

function handleIncorrect() {
  attemptCount++;

  const isRetry = attemptCount < MAX_ATTEMPTS_PER_LETTER;

  if (isRetry) {
    feedbackEl.textContent = "✕ Try again!";
    feedbackEl.style.color = "#c62828";
    statusEl.textContent += "\nPlaying wrong sound and retrying…";

    // After wrong sound, retry listening
    recordJsTiming("js_audio_start_ms");
    refreshTimingSummaryAfterAudio();
    playSound(soundWrongEl, () => {
      startListeningForCurrentLetter();
    });
  } else {
    feedbackEl.textContent = "✕ Wrong letter.";
    feedbackEl.style.color = "#c62828";
    statusEl.textContent += "\nPlaying wrong sound and moving on…";

    // On final wrong, let the sound finish then advance
    recordJsTiming("js_audio_start_ms");
    refreshTimingSummaryAfterAudio();
    playSound(soundWrongEl, () => {
      advanceToNextLetter();
    });
  }
}

function retryOrAdvance() {
  attemptCount++;

  if (attemptCount < MAX_ATTEMPTS_PER_LETTER) {
    startListeningForCurrentLetter();
  } else {
    advanceToNextLetter();
  }
}

// --- Game flow ---------------------------------------------------------------

function advanceToNextLetter(options) {
  const skipListening = options && options.skipListening;

  currentIndex++;

  if (currentIndex >= LETTER_SEQUENCE.length) {
    endGame();
  } else {
    updateUIForCurrentLetter();
    if (sttEnabled && !sttFatalError && window.LimeTunaSpeech && window.cordova) {
      startListeningForCurrentLetter();
    } else if (skipListening) {
      // STT is unavailable; keep rendering remaining letters so the session can finish.
      setTimeout(() => advanceToNextLetter({ skipListening: true }), 300);
    }
  }
}

function endGame() {
  resetTimingIndicator();
  const total = LETTER_SEQUENCE.length;
  statusEl.textContent =
    "Game over.\n" + `You got ${correctCount} out of ${total} letters right.`;
  feedbackEl.textContent = "";
  feedbackEl.style.color = "";

  const msg = `You got ${correctCount} out of ${total} letters right.`;
  finalScoreEl.textContent = msg;
  finalScoreEl.classList.remove("hidden");

  if (restartGameBtn) {
    restartGameBtn.classList.remove("hidden");
  }

  if (window.cordova && window.LimeTunaSpeech) {
    if (LimeTunaSpeech.setKeepScreenOn) {
      LimeTunaSpeech.setKeepScreenOn(false);
    }
    // We keep beeps muted until user leaves with the back button
  }

  if (correctCount >= 8) {
    // Correct sound already had its 2 seconds, so win won't overlap it.
    playSound(soundWinEl);
  } else {
    playSound(soundLoseEl);
  }
}

// --- Bootstrap ---------------------------------------------------------------

function onLettersDeviceReady() {
  console.log("Letters game deviceready fired");
  initLettersGame();
}

if (window.cordova) {
  document.addEventListener("deviceready", onLettersDeviceReady, false);
} else {
  document.addEventListener("DOMContentLoaded", () => {
    console.log(
      "No Cordova detected, running Letters game in browser mode (no speech)."
    );
    initLettersGame();
  });
}
