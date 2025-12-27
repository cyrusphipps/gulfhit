// letters.js – debug timing + sound sequencing + beep-mute integration

const ALL_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const MAX_ATTEMPTS_PER_LETTER = 2;
const CORRECT_SOUND_DURATION_MS = 2000; // correct.wav ~2s

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

let timingPanelEl;
let timingStageEl;
let timingSummaryEl;
let lastTimingRenderMs = 0;
let timingDisplayState = {
  stageText: "Timing idle",
  summaryText: "Timings will appear after you speak."
};

function shuffleArray(arr) {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
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

function describeStage(label, timestamp, originTs) {
  if (!timestamp || !originTs) return `${label} …`;
  const delta = timestamp - originTs;
  return `${label} ✓ (+${Math.round(delta)} ms)`;
}

function buildStageLines(timingPayload) {
  if (!timingPayload || !timingPayload.native_raw) {
    return ["Starting…", "Waiting for engine ready…", "Detected speech…", "Engine processing…", "Result received…"];
  }
  const raw = timingPayload.native_raw;
  const anchor = raw.native_received_ms || raw.native_startListening_ms || null;
  return [
    describeStage("Starting…", raw.native_startListening_ms, anchor || raw.native_received_ms),
    describeStage("Waiting for engine ready…", raw.native_readyForSpeech_ms, anchor || raw.native_startListening_ms),
    describeStage(
      "Detected speech…",
      raw.native_beginningOfSpeech_ms || raw.native_firstRmsAboveThreshold_ms,
      raw.native_readyForSpeech_ms || anchor || raw.native_startListening_ms
    ),
    describeStage("Engine processing…", raw.native_endOfSpeech_ms, raw.native_beginningOfSpeech_ms || raw.native_firstRmsAboveThreshold_ms || anchor),
    describeStage("Result received…", raw.native_results_ms || raw.native_error_ms || raw.native_callback_sent_ms, anchor)
  ];
}

function buildTimingSummary(nativeDurations, jsDurations) {
  const parts = [];
  if (nativeDurations) {
    if (nativeDurations.d_queue_native_ms !== undefined) parts.push(`Queue→native: ${formatMs(nativeDurations.d_queue_native_ms)}`);
    if (nativeDurations.d_engine_ready_ms !== undefined) parts.push(`Engine ready: ${formatMs(nativeDurations.d_engine_ready_ms)}`);
    if (nativeDurations.d_user_speech_to_engine_ms !== undefined)
      parts.push(`User→engine: ${formatMs(nativeDurations.d_user_speech_to_engine_ms)}`);
    if (nativeDurations.d_engine_processing_ms !== undefined)
      parts.push(`Processing: ${formatMs(nativeDurations.d_engine_processing_ms)}`);
    if (nativeDurations.d_normalize_ms !== undefined) parts.push(`Normalize: ${formatMs(nativeDurations.d_normalize_ms)}`);
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

function startNewGame() {
  LETTER_SEQUENCE = shuffleArray(ALL_LETTERS).slice(0, 10);
  currentIndex = 0;
  correctCount = 0;
  attemptCount = 0;
  recognizing = false;
  sttFatalError = false;
  updateTimingPanel(
    {
      stageText: "Timing idle",
      summaryText: "Timings will appear after you speak."
    },
    true
  );

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
    statusEl.textContent = "Phase 0: preparing microphone…";

    LimeTunaSpeech.init(
      {
        language: "en-US"
      },
      function () {
        console.log("LimeTunaSpeech.init success");
        sttEnabled = true;
        statusEl.textContent =
          "Phase 1: ready. Say the letter when you're ready.";
        startListeningForCurrentLetter();
      },
      function (err) {
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
    statusEl.textContent = "Speech not available in this environment.";
  }
}

// --- UI update ---------------------------------------------------------------

function updateUIForCurrentLetter() {
  attemptCount = 0;

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

  recognizing = true;
  lastListenStartTs = performance.now();
  currentAttemptTiming = {
    js_start_ms: lastListenStartTs
  };
  statusEl.textContent =
    "Phase 1: listening for speech (waiting for Android speech engine)…";
  console.log("[letters] stage=startListening", {
    expected,
    js_start_ms: lastListenStartTs
  });
  updateTimingPanel(
    {
      stageText: "Waiting for engine ready…",
      summaryText: "Start request sent to native speech engine…"
    },
    true
  );

  LimeTunaSpeech.startLetter(
    expected,
    function (result) {
      const resultArrivalTs = performance.now();
      const engineMs = resultArrivalTs - lastListenStartTs;
      recordJsTiming("js_got_result_ms");

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

      // 2) Debug: tell you exactly where the time went
      statusEl.textContent =
        `Phase 2: result received.\n` +
        `Engine: ~${engineMs.toFixed(0)} ms, JS map: ~${mapMs.toFixed(
          1
        )} ms.\n` +
        `Heard: "${rawText || ""}" → "${normalized || ""}" (expected "${expectedUpper}")\n` +
        `Phase 3: scoring and playing ${isCorrect ? "correct" : "wrong"} sound…\n` +
        `Timings: ${summaryText}`;

      console.log("[letters] result received", {
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
      recognizing = false;

      const now = performance.now();
      const engineMs = now - lastListenStartTs;
      recordJsTiming("js_got_result_ms");

      const code = parseErrorCode(err);
      console.error("LimeTunaSpeech.startLetter error:", err, "code=", code);
      const timingPayload = err && err.timing ? err.timing : null;
      if (currentAttemptTiming) {
        currentAttemptTiming.lastTimingPayload = timingPayload;
      }
      const nativeDurations = timingPayload && timingPayload.native_durations ? timingPayload.native_durations : null;
      const jsDurations = {};
      if (currentAttemptTiming && currentAttemptTiming.js_start_ms !== undefined) {
        jsDurations.d_total_js = now - currentAttemptTiming.js_start_ms;
      } else {
        jsDurations.d_total_js = engineMs;
      }
      const stageLines = buildStageLines(timingPayload);
      const summaryText = buildTimingSummary(nativeDurations, jsDurations);
      console.log("[letters] stage=error", {
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

      if (isHardSttErrorCode(code)) {
        sttFatalError = true;
        sttEnabled = false;
        statusEl.textContent =
          `Phase 2: engine error after ~${engineMs.toFixed(
            0
          )} ms.\n` +
          `Speech engine error (${code || "unknown"}). Letters will show without listening.\n` +
          `Timings: ${summaryText}`;
        return;
      }

      statusEl.textContent =
        `Phase 2: soft error after ~${engineMs.toFixed(
          0
        )} ms.\n` +
        `Didn't catch that (error ${code || "unknown"}). Phase 3: retry logic.\n` +
        `Timings: ${summaryText}`;

      retryOrAdvance();
    }
  );
}

function handleCorrect() {
  const isLast = currentIndex === LETTER_SEQUENCE.length - 1;

  feedbackEl.textContent = "✓ Correct!";
  feedbackEl.style.color = "#2e7d32";
  statusEl.textContent += "\nPhase 4: correct feedback.";

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
    statusEl.textContent += "\nPhase 4: wrong (retry) feedback.";

    // After wrong sound, retry listening
    recordJsTiming("js_audio_start_ms");
    refreshTimingSummaryAfterAudio();
    playSound(soundWrongEl, () => {
      startListeningForCurrentLetter();
    });
  } else {
    feedbackEl.textContent = "✕ Wrong letter.";
    feedbackEl.style.color = "#c62828";
    statusEl.textContent += "\nPhase 4: wrong (advance) feedback.";

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

function advanceToNextLetter() {
  currentIndex++;

  if (currentIndex >= LETTER_SEQUENCE.length) {
    endGame();
  } else {
    updateUIForCurrentLetter();
    if (sttEnabled && !sttFatalError && window.LimeTunaSpeech && window.cordova) {
      startListeningForCurrentLetter();
    }
  }
}

function endGame() {
  const total = LETTER_SEQUENCE.length;
  statusEl.textContent =
    "Phase 5: game over.\n" +
    `You got ${correctCount} out of ${total} letters right.`;
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
