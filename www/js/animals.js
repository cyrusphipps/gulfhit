// animals.js – simple speech game modeled after Letters

const ANIMALS = [
  {
    name: "Dog",
    images: ["img/animals/dog1.webp", "img/animals/dog2.webp", "img/animals/dog3.webp"],
    keywords: ["dog", "puppy"]
  },
  {
    name: "Cat",
    images: ["img/animals/cat1.webp", "img/animals/cat2.webp", "img/animals/cat3.webp"],
    keywords: ["cat", "kitten"]
  },
  {
    name: "Fish",
    images: ["img/animals/fish1.webp", "img/animals/fish2.webp", "img/animals/fish3.webp"],
    keywords: ["fish"]
  },
  {
    name: "Bird",
    images: ["img/animals/bird1.webp", "img/animals/bird2.webp", "img/animals/bird3.webp"],
    keywords: ["bird", "parrot"]
  },
  {
    name: "Spider",
    images: ["img/animals/spider1.webp", "img/animals/spider2.webp", "img/animals/spider3.webp"],
    keywords: ["spider"]
  },
  {
    name: "Horse",
    images: ["img/animals/horse1.webp", "img/animals/horse2.webp", "img/animals/horse3.webp"],
    keywords: ["horse", "pony"]
  }
];

const TOTAL_ROUNDS = 10;
const MAX_ATTEMPTS_PER_ANIMAL = 4;
const MAX_ANIMAL_OCCURRENCES = 2;
const ANIMALS_STATUS_PROMPT = "Say the animal when you're ready.";
const ANIMALS_SPEECH_OPTIONS = {
  language: "en-US",
  maxUtteranceMs: 10000, // 10 seconds per attempt
  postSilenceMs: 10000, // keep the mic open the full window even if quiet
  minPostSilenceMs: 10000
};
const ANIMALS_LISTENING_WATCHDOG_MS = 10000;

let animalSequence = [];
let currentIndex = 0;
let correctCount = 0;
let attemptCount = 0;
let recognizing = false;
let lastOneMoreTimeSound = null;
let lastPreQuestionSound = null;

let sttEnabled = false;
let sttFatalError = false;

let progressEl;
let statusEl;
let feedbackEl;
let finalScoreEl;
let backToHomeBtn;
let restartGameBtn;
let animalImageEl;
let timingPanelEl;
let timingStageEl;
let timingSummaryEl;
let rmsNoteEl;
let lastDebugEvent = null;

let soundCorrectEl;
let soundWrongEl;
let soundOneMoreTimeEls = [];
let animalEffectEls = {};
let attemptWindowStartMs = null;
let listeningWatchdogTimerId = null;
let lastThresholds = null;
let currentAttemptHadSpeech = false;
let anySpeechHeardThisAnimal = false;
let chanceEl;
let fastNoMatchSkipBudget = 1;
let lastStartedAttemptIndex = null;
let preQuestionSounds = [];
let animalsPreQuestionSounds = [];
let alreadyListeningRecoveryBudget = 0;
let engineRestartRecoveryBudget = 0;

const audioCache = new Map();

function getNowMs() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function shuffleArray(arr) {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function buildAnimalSequence() {
  const imagePool = [];

  ANIMALS.forEach((animal) => {
    const variants = Array.isArray(animal.images) && animal.images.length ? animal.images : [animal.image];
    variants.forEach((imagePath) => {
      imagePool.push({ animal, image: imagePath });
    });
  });

  const animalCounts = new Map();
  const result = [];
  let lastAnimalName = null;
  const usedImages = new Set();

  while (result.length < TOTAL_ROUNDS) {
    const availablePool = imagePool.filter(
      (entry) => !usedImages.has(entry.image) && (animalCounts.get(entry.animal.name) || 0) < MAX_ANIMAL_OCCURRENCES
    );

    if (!availablePool.length) break;

    const preferred = availablePool.filter((entry) => entry.animal.name !== lastAnimalName);
    const shuffledPool = shuffleArray(preferred.length ? preferred : availablePool);
    const entry = shuffledPool[0];

    result.push({
      ...entry.animal,
      image: entry.image
    });
    animalCounts.set(entry.animal.name, (animalCounts.get(entry.animal.name) || 0) + 1);
    lastAnimalName = entry.animal.name;
    usedImages.add(entry.image);
  }

  return result;
}

function getAudioElement(source) {
  if (!source) return null;
  if (typeof HTMLAudioElement !== "undefined" && source instanceof HTMLAudioElement) return source;

  if (audioCache.has(source)) return audioCache.get(source);

  const audio = new Audio(source);
  audio.preload = "auto";
  audio.muted = false;
  audio.volume = 1.0;
  audioCache.set(source, audio);
  return audio;
}

function playSound(elOrSrc, onEnded) {
  const el = getAudioElement(elOrSrc);
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

function forceStopNativeListening() {
  if (window.cordova && window.LimeTunaSpeech && typeof LimeTunaSpeech.stop === "function") {
    try {
      LimeTunaSpeech.stop();
    } catch (e) {
      console.warn("Failed to stop native listening (safe if idle):", e);
    }
  }
}

function clearListeningWatchdog() {
  if (listeningWatchdogTimerId) {
    clearTimeout(listeningWatchdogTimerId);
    listeningWatchdogTimerId = null;
  }
}

function startListeningWatchdog(elapsedMs) {
  clearListeningWatchdog();
  const alreadyElapsed = typeof elapsedMs === "number" ? Math.max(0, elapsedMs) : 0;
  const remaining = Math.max(0, ANIMALS_LISTENING_WATCHDOG_MS - alreadyElapsed);
  listeningWatchdogTimerId = setTimeout(() => {
    listeningWatchdogTimerId = null;
    recognizing = false;
    statusEl.textContent = "Time is up for this animal.";
    handleIncorrect({ reason: "timeout" });
  }, remaining);
}

function chooseRandomSound(pool, lastSound) {
  if (!Array.isArray(pool) || !pool.length) return null;
  const filtered = pool.filter((item) => item && item !== lastSound);
  const selectionPool = filtered.length ? filtered : pool.filter(Boolean);
  if (!selectionPool.length) return null;
  const idx = Math.floor(Math.random() * selectionPool.length);
  return selectionPool[idx];
}

function getPreQuestionSound(questionIndex) {
  const isFirstQuestion = questionIndex === 0;
  const pool = isFirstQuestion
    ? animalsPreQuestionSounds
    : [...animalsPreQuestionSounds, ...preQuestionSounds];
  const sound = chooseRandomSound(pool, lastPreQuestionSound);
  if (sound) {
    lastPreQuestionSound = sound;
  }
  return sound;
}

function playPreQuestionPrompt(questionIndex, onComplete) {
  const prompt = getPreQuestionSound(questionIndex);
  if (!prompt) {
    if (typeof onComplete === "function") onComplete();
    return;
  }
  playSound(prompt, onComplete);
}

function getDisplayChanceNumber() {
  return Math.min(attemptCount + 1, MAX_ATTEMPTS_PER_ANIMAL);
}

function updateChanceDisplay() {
  if (chanceEl) {
    chanceEl.textContent = `Chance ${getDisplayChanceNumber()} / ${MAX_ATTEMPTS_PER_ANIMAL}`;
  }
}

function getNoMatchPrompt(completedAttemptNumber, animal) {
  if (completedAttemptNumber === 1 || completedAttemptNumber === 3) {
    return animalEffectEls[animal && animal.name];
  }
  if (completedAttemptNumber === 2) {
    const prompt = chooseRandomSound(soundOneMoreTimeEls, lastOneMoreTimeSound);
    if (prompt) lastOneMoreTimeSound = prompt;
    return prompt;
  }
  return null;
}

function playNoSoundPromptIfNeeded(completedAttemptNumber, animal, onComplete, options = {}) {
  const force = options && options.force;
  if (anySpeechHeardThisAnimal && !force) {
    if (typeof onComplete === "function") onComplete();
    return;
  }

  const prompt = getNoMatchPrompt(completedAttemptNumber, animal);

  if (!prompt) {
    if (typeof onComplete === "function") onComplete();
    return;
  }

  playSound(prompt, onComplete);
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

function setTimingPanel({ stage, summary, thresholds }) {
  if (thresholds) {
    lastThresholds = thresholds;
  }
  if (timingStageEl && stage) {
    timingStageEl.textContent = stage;
  }
  if (timingSummaryEl && summary) {
    timingSummaryEl.textContent = summary;
  }
  if (rmsNoteEl && lastThresholds) {
    const endEffective =
      typeof lastThresholds.adaptive_end_threshold_db === "number"
        ? lastThresholds.adaptive_end_threshold_db
        : lastThresholds.rms_end_threshold_db;
    const postSilence =
      lastThresholds.post_silence_ms_effective !== undefined
        ? lastThresholds.post_silence_ms_effective
        : lastThresholds.post_silence_ms;
    const baseline =
      typeof lastThresholds.baseline_rms_db === "number"
        ? lastThresholds.baseline_rms_db
        : null;
    const parts = [
      `End=${endEffective != null ? endEffective.toFixed(1) : "?"} dB`,
      `Post silence=${postSilence != null ? postSilence : "?"} ms`,
      `Max utterance=${lastThresholds.max_utterance_ms != null ? lastThresholds.max_utterance_ms : "?"} ms`
    ];
    if (baseline !== null) {
      parts.push(`Baseline=${baseline.toFixed(2)} dB`);
    }
    rmsNoteEl.textContent = `Thresholds: ${parts.join(" · ")}`;
  } else if (rmsNoteEl && stage && stage.toLowerCase().indexOf("waiting") !== -1) {
    rmsNoteEl.textContent = "Thresholds will appear after the first native update.";
  }
}

function handleDebugEvent(evt) {
  if (!evt || evt.type !== "event") return;
  lastDebugEvent = evt;
  const thresholds = evt.timing && evt.timing.native_thresholds ? evt.timing.native_thresholds : null;
  const commitReason = evt.extras && evt.extras.commit_reason ? evt.extras.commit_reason : null;
  const stageLabel = (evt.event || "event").replace(/_/g, " ");
  const summaryParts = [`Event: ${evt.event || "unknown"}`];
  if (commitReason) {
    summaryParts.push(`Reason: ${commitReason}`);
  }
  if (evt.event === "onBeginningOfSpeech") {
    currentAttemptHadSpeech = true;
    anySpeechHeardThisAnimal = true;
    fastNoMatchSkipBudget = 1;
  }
  setTimingPanel({
    stage: stageLabel,
    summary: summaryParts.join(" · "),
    thresholds
  });
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

function normalizeText(text) {
  if (!text) return "";
  return text
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;

  const rows = b.length + 1;
  const cols = a.length + 1;
  const dist = new Array(rows);

  for (let i = 0; i < rows; i++) {
    dist[i] = new Array(cols);
    dist[i][0] = i;
  }
  for (let j = 0; j < cols; j++) {
    dist[0][j] = j;
  }

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = b.charAt(i - 1) === a.charAt(j - 1) ? 0 : 1;
      dist[i][j] = Math.min(
        dist[i - 1][j] + 1,
        dist[i][j - 1] + 1,
        dist[i - 1][j - 1] + cost
      );
    }
  }

  return dist[rows - 1][cols - 1];
}

function isFuzzySimilar(candidate, keyword) {
  if (!candidate || !keyword) return false;

  const distance = levenshteinDistance(candidate, keyword);
  const tolerance = keyword.length <= 4 ? 1 : 2;

  return distance > 0 && distance <= tolerance;
}

function isAnimalMatch(results, animal) {
  const keywords = (animal.keywords || [animal.name]).map((w) => normalizeText(w));
  const candidates = (results || []).map((r) => normalizeText(r)).filter(Boolean);

  for (const candidate of candidates) {
    for (const keyword of keywords) {
      if (!keyword) continue;
      if (candidate === keyword) return true;
      if (candidate.startsWith(keyword)) return true;
      if (candidate.includes(keyword)) return true;
      const words = candidate.split(" ");
      if (words.includes(keyword)) return true;
      if (isFuzzySimilar(candidate, keyword)) return true;
      if (words.some((w) => isFuzzySimilar(w, keyword))) return true;
    }
  }
  return false;
}

function getAnimalImage(animal) {
  if (!animal) return "";
  if (animal.image) return animal.image;
  const variants = Array.isArray(animal.images) ? animal.images : [];
  return variants[0] || "";
}

function initAnimalsGame() {
  progressEl = document.getElementById("animalsProgress");
  statusEl = document.getElementById("animalsStatus");
  feedbackEl = document.getElementById("animalsFeedback");
  finalScoreEl = document.getElementById("finalScore");
  backToHomeBtn = document.getElementById("backToHomeBtn");
  restartGameBtn = document.getElementById("restartGameBtn");
  animalImageEl = document.getElementById("animalImage");
  timingPanelEl = document.getElementById("animalsTiming");
  timingStageEl = document.getElementById("animalsTimingStage");
  timingSummaryEl = document.getElementById("animalsTimingSummary");
  rmsNoteEl = document.getElementById("animalsRmsNote");
  chanceEl = document.getElementById("animalsChance");

  soundCorrectEl = document.getElementById("soundCorrect");
  soundWrongEl = document.getElementById("soundWrong");
  soundOneMoreTimeEls = [
    "audio/one_more_time1.mp3",
    "audio/one_more_time2.mp3",
    "audio/one_more_time3.mp3"
  ].map(getAudioElement);
  preQuestionSounds = [
    "audio/pre_question1.mp3",
    "audio/pre_question2.mp3",
    "audio/pre_question3.mp3"
  ].map(getAudioElement);
  animalsPreQuestionSounds = [
    "audio/animals/pre_question1.mp3",
    "audio/animals/pre_question2.mp3",
    "audio/animals/pre_question3.mp3"
  ].map(getAudioElement);

  ANIMALS.forEach((animal) => {
    const key = animal.name;
    const base = (animal.name || "").toLowerCase();
    animalEffectEls[key] = getAudioElement(`audio/animals/${base}_e.wav`);
  });

  [soundCorrectEl, soundWrongEl].forEach((el) => {
    if (el) {
      el.muted = false;
      el.volume = 1.0;
    }
  });

  if (!progressEl || !statusEl || !feedbackEl || !finalScoreEl || !animalImageEl) {
    console.error("Animals screen elements not found.");
    return;
  }

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
  animalSequence = buildAnimalSequence();
  currentIndex = 0;
  correctCount = 0;
  attemptCount = 0;
  recognizing = false;
  sttFatalError = false;
  lastOneMoreTimeSound = null;
  lastPreQuestionSound = null;
  attemptWindowStartMs = null;
  currentAttemptHadSpeech = false;
  anySpeechHeardThisAnimal = false;
  clearListeningWatchdog();
  engineRestartRecoveryBudget = 2;

  finalScoreEl.classList.add("hidden");
  if (restartGameBtn) restartGameBtn.classList.add("hidden");
  feedbackEl.textContent = "";
  feedbackEl.style.color = "";
  statusEl.textContent = ANIMALS_STATUS_PROMPT;

  updateUIForCurrentAnimal();

  if (window.cordova && window.LimeTunaSpeech) {
    if (LimeTunaSpeech.setKeepScreenOn) {
      LimeTunaSpeech.setKeepScreenOn(true);
    }
    if (LimeTunaSpeech.setBeepsMuted) {
      LimeTunaSpeech.setBeepsMuted(true);
    }
  }

  if (window.LimeTunaSpeech && window.cordova) {
    LimeTunaSpeech.init(
      ANIMALS_SPEECH_OPTIONS,
      function () {
        console.log("LimeTunaSpeech.init success (animals)");
        sttEnabled = true;
        statusEl.textContent = ANIMALS_STATUS_PROMPT;
        startQuestionWithPrompt();
      },
      function (err) {
        sttEnabled = false;
        sttFatalError = true;
        console.error("LimeTunaSpeech.init error (animals):", err);
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
    startQuestionWithPrompt({ skipListening: true });
  }
}

function updateUIForCurrentAnimal() {
  attemptCount = 0;
  currentAttemptHadSpeech = false;
  anySpeechHeardThisAnimal = false;
  fastNoMatchSkipBudget = 1;
  lastStartedAttemptIndex = null;
  engineRestartRecoveryBudget = 2;

  const total = animalSequence.length;
  const displayIndex = Math.min(currentIndex + 1, total);
  const sequenceAnimal = animalSequence[currentIndex];
  const fallbackAnimal = ANIMALS[0]
    ? { ...ANIMALS[0], image: getAnimalImage(ANIMALS[0]) }
    : null;
  const animal = sequenceAnimal || fallbackAnimal;
  const imagePath = getAnimalImage(animal);

  progressEl.textContent = `${displayIndex} / ${total}`;
  if (imagePath) {
    animalImageEl.src = imagePath;
  }
  animalImageEl.alt = (animal && animal.name) || "Animal";
  feedbackEl.textContent = "";
  feedbackEl.style.color = "";
  updateChanceDisplay();
  setTimingPanel({
    stage: "Waiting",
    summary: "Speech debug will appear once listening starts."
  });
}

function startListeningForCurrentAnimal(options = {}) {
  const preserveAttemptStart = !!options.preserveAttemptStart;

  clearListeningWatchdog();
  updateChanceDisplay();
  lastDebugEvent = null;

  if (lastStartedAttemptIndex !== attemptCount) {
    fastNoMatchSkipBudget = 1;
    lastStartedAttemptIndex = attemptCount;
  }

  if (!sttEnabled || sttFatalError || !window.LimeTunaSpeech || !window.cordova) {
    statusEl.textContent = "Speech engine not available.";
    attemptWindowStartMs = null;
    setTimingPanel({ stage: "Unavailable", summary: "Cordova speech engine missing." });
    return;
  }

  if (recognizing) {
    console.log("Already recognizing; ignoring extra start.");
    return;
  }

  // Defensive: ensure the native recognizer is stopped before starting a new attempt.
  forceStopNativeListening();
  alreadyListeningRecoveryBudget = 1;

  const animal = animalSequence[currentIndex];
  if (!animal) {
    console.warn("No animal at index", currentIndex);
    return;
  }

  const beginListening = () => {
    if (recognizing) {
      console.log("Already recognizing; ignoring extra start.");
      return;
    }

    const now = getNowMs();
    if (!attemptWindowStartMs || !preserveAttemptStart) {
      attemptWindowStartMs = now;
    }
    const elapsedMs = attemptWindowStartMs ? now - attemptWindowStartMs : 0;
    startListeningWatchdog(elapsedMs);

    recognizing = true;
    statusEl.textContent = ANIMALS_STATUS_PROMPT;
    setTimingPanel({
      stage: "Listening",
      summary: "Waiting for speech…"
    });
    currentAttemptHadSpeech = false;

    try {
      LimeTunaSpeech.startLetter(
        animal.name,
        function (result) {
          currentAttemptHadSpeech = true;
          anySpeechHeardThisAnimal = true;
          clearListeningWatchdog();
          attemptWindowStartMs = null;
          recognizing = false;
          const rawText = result && result.text ? result.text : "";
          const allResults =
            result && Array.isArray(result.allResults) ? result.allResults.slice() : [];
          const heard = [rawText, ...allResults];

          const isCorrect = isAnimalMatch(heard, animal);
          console.log("[animals] result", { animal: animal.name, rawText, allResults, isCorrect });
          statusEl.textContent = ANIMALS_STATUS_PROMPT;

          if (isCorrect) {
            handleCorrect(animal);
            setTimingPanel({
              stage: "Result",
              summary: `Heard: "${rawText || allResults[0] || ""}" (correct)`
            });
          } else {
            handleIncorrect({ reason: "wrong" });
            setTimingPanel({
              stage: "Result",
              summary: `Heard: "${rawText || allResults[0] || ""}" (not a match)`
            });
          }
        },
        function (err) {
          clearListeningWatchdog();
          recognizing = false;
          const code = parseErrorCode(err);
          const elapsedMs = attemptWindowStartMs ? getNowMs() - attemptWindowStartMs : null;
          const lastCommit =
            lastDebugEvent && lastDebugEvent.extras && lastDebugEvent.extras.commit_reason
              ? lastDebugEvent.extras.commit_reason
              : lastDebugEvent && lastDebugEvent.event;
          console.error("LimeTunaSpeech.startLetter error (animals):", err, "code=", code);

          if (
            code === "NO_MATCH" &&
            !currentAttemptHadSpeech &&
            elapsedMs !== null &&
            elapsedMs < 700 &&
            lastCommit === "post_silence_commit" &&
            fastNoMatchSkipBudget > 0
          ) {
            fastNoMatchSkipBudget--;
            attemptWindowStartMs = null;
            statusEl.textContent = "Restarting… listening again.";
            setTimingPanel({
              stage: "Retrying",
              summary: "Ignored immediate post-silence no-match; retrying same attempt."
            });
            startListeningForCurrentAnimal({ preserveAttemptStart: false });
            return;
          }

          if (
            code === "NO_MATCH" &&
            !currentAttemptHadSpeech &&
            elapsedMs !== null &&
            elapsedMs < ANIMALS_LISTENING_WATCHDOG_MS
          ) {
            const remainingMs = Math.max(0, ANIMALS_LISTENING_WATCHDOG_MS - elapsedMs);
            statusEl.textContent = `Still listening… you have ${(remainingMs / 1000).toFixed(1)}s left.`;
            setTimingPanel({
              stage: "Retrying",
              summary: "No speech detected yet; keeping this chance open for the full window."
            });
            startListeningForCurrentAnimal({ preserveAttemptStart: true });
            return;
          }

          if (code === "NO_MATCH") {
            statusEl.textContent = "We couldn't hear that clearly. Try again.";
            handleIncorrect({ reason: "no_match" });
            setTimingPanel({
              stage: "No match",
              summary: "Recognizer ended without a match."
            });
            return;
          }

          if (code === "ALREADY_LISTENING") {
            forceStopNativeListening();
            if (alreadyListeningRecoveryBudget > 0) {
              alreadyListeningRecoveryBudget--;
              statusEl.textContent = "Restarting listener…";
              setTimingPanel({
                stage: "Retrying",
                summary: "Native engine reported busy; retrying after stop()."
              });
              startListeningForCurrentAnimal({ preserveAttemptStart: true });
              return;
            }
            sttFatalError = true;
            sttEnabled = false;
            statusEl.textContent = "Speech engine stuck in listening state. Showing animals without listening.";
            advanceToNextAnimal({ skipListening: true });
            return;
          }

          if (
            (code === "ERROR_SPEECH_TIMEOUT" || code === "SPEECH_TIMEOUT") &&
            elapsedMs !== null &&
            elapsedMs < ANIMALS_LISTENING_WATCHDOG_MS
          ) {
            const remainingMs = Math.max(0, ANIMALS_LISTENING_WATCHDOG_MS - elapsedMs);
            statusEl.textContent = `Still listening… you have ${(remainingMs / 1000).toFixed(1)}s left.`;
            startListeningForCurrentAnimal({ preserveAttemptStart: true });
            setTimingPanel({
              stage: "Retrying",
              summary: "Timeout reported early; restarting listener."
            });
            return;
          }

          if (
            (code === "ENGINE_RESTART_REQUIRED" ||
              code === "ENGINE_RESET" ||
              code === "ERROR_SERVER_DISCONNECTED" ||
              code === "ERROR_11") &&
            typeof LimeTunaSpeech.resetRecognizer === "function"
          ) {
            if (engineRestartRecoveryBudget > 0) {
              engineRestartRecoveryBudget--;
              statusEl.textContent = "Restarting speech engine…";
              setTimingPanel({
                stage: "Resetting",
                summary: `Attempting to recover from ${code}`
              });
              LimeTunaSpeech.resetRecognizer(
                () => {
                  attemptWindowStartMs = null;
                  setTimeout(
                    () => startListeningForCurrentAnimal({ preserveAttemptStart: false }),
                    120
                  );
                },
                () => {
                  sttFatalError = true;
                  sttEnabled = false;
                  statusEl.textContent = "Speech engine restart failed. Showing animals without listening.";
                  advanceToNextAnimal({ skipListening: true });
                }
              );
              return;
            }
            sttFatalError = true;
            sttEnabled = false;
            statusEl.textContent = "Speech engine unavailable. Showing animals without listening.";
            advanceToNextAnimal({ skipListening: true });
            return;
          }

          if (isHardSttErrorCode(code)) {
            sttFatalError = true;
            sttEnabled = false;
            statusEl.textContent = "Speech engine error. Showing animals without listening.";
            advanceToNextAnimal({ skipListening: true });
            return;
          }

          statusEl.textContent = "Error starting speech. Retrying…";
          retryOrAdvance();
          setTimingPanel({
            stage: "Error",
            summary: code ? `Engine reported ${code}` : "Unknown speech error"
          });
        },
        null,
        handleDebugEvent
      );
    } catch (err) {
      console.error("LimeTunaSpeech.startLetter threw synchronously (animals)", err);
      recognizing = false;
      attemptWindowStartMs = null;
      clearListeningWatchdog();
      statusEl.textContent = "Speech start failed. Retrying…";
      retryOrAdvance();
    }
  };

  beginListening();
}

function startQuestionWithPrompt(options = {}) {
  const skipListening =
    !!options.skipListening ||
    !sttEnabled ||
    sttFatalError ||
    !window.LimeTunaSpeech ||
    !window.cordova;

  playPreQuestionPrompt(currentIndex, () => {
    if (skipListening) {
      if (typeof options.onSkippedListening === "function") {
        options.onSkippedListening();
      }
      return;
    }
    startListeningForCurrentAnimal({ preserveAttemptStart: false });
  });
}

function handleCorrect(animal) {
  clearListeningWatchdog();
  attemptWindowStartMs = null;
  currentAttemptHadSpeech = true;
  anySpeechHeardThisAnimal = true;
  feedbackEl.textContent = "✓ Correct!";
  feedbackEl.style.color = "#2e7d32";
  statusEl.textContent = ANIMALS_STATUS_PROMPT;

  correctCount++;

  playSound(soundCorrectEl, () => {
    advanceToNextAnimal();
  });
}

function handleIncorrect(options = {}) {
  const reason = options.reason || "wrong";
  const animal = animalSequence[currentIndex];
  const completedAttemptNumber = attemptCount + 1;
  const noSpeechThisAttempt = (reason === "no_match" || reason === "timeout") && !currentAttemptHadSpeech;
  if (!noSpeechThisAttempt) {
    anySpeechHeardThisAnimal = true;
  }
  attemptCount++;
  clearListeningWatchdog();
  attemptWindowStartMs = null;

  const hasAttemptsRemaining = attemptCount < MAX_ATTEMPTS_PER_ANIMAL;

  const continueListening = () => {
    updateChanceDisplay();
    startListeningForCurrentAnimal({ preserveAttemptStart: false });
  };

  if (reason === "wrong") {
    feedbackEl.textContent = "✕ Try again!";
    feedbackEl.style.color = "#c62828";
    statusEl.textContent = ANIMALS_STATUS_PROMPT;

    if (!hasAttemptsRemaining) {
      playSound(soundWrongEl, () => {
        advanceToNextAnimal();
      });
      return;
    }

    // Jump straight to the final chance after playing wrong.wav.
    attemptCount = MAX_ATTEMPTS_PER_ANIMAL - 1;
    updateChanceDisplay();
    playSound(soundWrongEl, () => {
      continueListening();
    });
    return;
  }

  if (!hasAttemptsRemaining) {
    feedbackEl.textContent = "✕ Wrong answer.";
    feedbackEl.style.color = "#c62828";
    statusEl.textContent = ANIMALS_STATUS_PROMPT;
    playSound(soundWrongEl, () => {
      advanceToNextAnimal();
    });
    return;
  }

  feedbackEl.textContent = noSpeechThisAttempt ? "We didn't hear anything. Try again!" : "✕ Try again!";
  feedbackEl.style.color = "#c62828";
  statusEl.textContent = ANIMALS_STATUS_PROMPT;

  if (reason === "no_match" || noSpeechThisAttempt) {
    playNoSoundPromptIfNeeded(completedAttemptNumber, animal, () => {
      continueListening();
    }, { force: reason === "no_match" });
    return;
  }

  continueListening();
}

function retryOrAdvance() {
  attemptCount = Math.min(MAX_ATTEMPTS_PER_ANIMAL, attemptCount + 1);
  clearListeningWatchdog();
  attemptWindowStartMs = null;
  updateChanceDisplay();

  if (attemptCount < MAX_ATTEMPTS_PER_ANIMAL) {
    startListeningForCurrentAnimal({ preserveAttemptStart: false });
  } else {
    advanceToNextAnimal();
  }
}

function advanceToNextAnimal(options) {
  const skipListening = options && options.skipListening;
  clearListeningWatchdog();
  attemptWindowStartMs = null;

  currentIndex++;

  if (currentIndex >= animalSequence.length) {
    endGame();
  } else {
    updateUIForCurrentAnimal();
    const shouldSkipListening =
      skipListening || sttFatalError || !sttEnabled || !window.LimeTunaSpeech || !window.cordova;
    startQuestionWithPrompt({
      skipListening: shouldSkipListening,
      onSkippedListening: shouldSkipListening
        ? () => setTimeout(() => advanceToNextAnimal({ skipListening: true }), 300)
        : null
    });
  }
}

function endGame() {
  const total = animalSequence.length;
  statusEl.textContent = "";
  feedbackEl.textContent = "";
  feedbackEl.style.color = "";

  const msg = `Score: ${correctCount} / ${total}`;
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
}

function onAnimalsDeviceReady() {
  console.log("Animals game deviceready fired");
  initAnimalsGame();
}

if (window.cordova) {
  document.addEventListener("deviceready", onAnimalsDeviceReady, false);
} else {
  document.addEventListener("DOMContentLoaded", () => {
    console.log("No Cordova detected, running Animals game in browser mode (no speech).");
    initAnimalsGame();
  });
}
