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

function startNewGame() {
  LETTER_SEQUENCE = shuffleArray(ALL_LETTERS).slice(0, 10);
  currentIndex = 0;
  correctCount = 0;
  attemptCount = 0;
  recognizing = false;
  sttFatalError = false;

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
  statusEl.textContent =
    "Phase 1: listening for speech (waiting for Android speech engine)…";

  LimeTunaSpeech.startLetter(
    expected,
    function (result) {
      const resultArrivalTs = performance.now();
      const engineMs = resultArrivalTs - lastListenStartTs;

      recognizing = false;

      const mapStart = performance.now();

      const rawText = result && result.text;
      const normalized = result && result.normalizedLetter;
      const expectedUpper = expected.toUpperCase();

      let isCorrect = false;
      if (normalized && normalized === expectedUpper) {
        isCorrect = true;
      }

      const mapEnd = performance.now();
      const mapMs = mapEnd - mapStart;

      // 2) Debug: tell you exactly where the time went
      statusEl.textContent =
        `Phase 2: result received.\n` +
        `Engine: ~${engineMs.toFixed(0)} ms, JS map: ~${mapMs.toFixed(
          1
        )} ms.\n` +
        `Heard: "${rawText || ""}" → "${normalized || ""}" (expected "${expectedUpper}")\n` +
        `Phase 3: scoring and playing ${
          isCorrect ? "correct" : "wrong"
        } sound…`;

      console.log("[Letters] timings", {
        engineMs,
        mapMs,
        result,
        expected: expectedUpper,
      });

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

      const code = parseErrorCode(err);
      console.error("LimeTunaSpeech.startLetter error:", err, "code=", code);

      if (isHardSttErrorCode(code)) {
        sttFatalError = true;
        sttEnabled = false;
        statusEl.textContent =
          `Phase 2: engine error after ~${engineMs.toFixed(
            0
          )} ms.\n` +
          `Speech engine error (${code || "unknown"}). Letters will show without listening.`;
        return;
      }

      statusEl.textContent =
        `Phase 2: soft error after ~${engineMs.toFixed(
          0
        )} ms.\n` +
        `Didn't catch that (error ${code || "unknown"}). Phase 3: retry logic.`;

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
    playSound(soundWrongEl, () => {
      startListeningForCurrentLetter();
    });
  } else {
    feedbackEl.textContent = "✕ Wrong letter.";
    feedbackEl.style.color = "#c62828";
    statusEl.textContent += "\nPhase 4: wrong (advance) feedback.";

    // On final wrong, let the sound finish then advance
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
