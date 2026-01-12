// animals.js – simple speech game modeled after Letters

const ANIMALS = [
  {
    name: "Dog",
    base: "dog",
    keywords: ["dog", "puppy"]
  },
  {
    name: "Cat",
    base: "cat",
    keywords: ["cat", "kitten"]
  },
  {
    name: "Fish",
    base: "fish",
    keywords: ["fish"]
  },
  {
    name: "Bird",
    base: "bird",
    keywords: ["bird", "parrot"]
  },
  {
    name: "Spider",
    base: "spider",
    keywords: ["spider"]
  },
  {
    name: "Horse",
    base: "horse",
    keywords: ["horse", "pony"]
  }
];

const TOTAL_ROUNDS = 10;
const MAX_ATTEMPTS_PER_ANIMAL = 2;
const MAX_ANIMAL_OCCURRENCES = 2;
const ANIMAL_IMAGE_VARIANTS = 5;
const CORRECT_SOUND_DURATION_MS = 2000; // correct.wav ~2s
const CORRECT_VARIANT_OVERLAP_MS = 2000;
const ANIMALS_STATUS_PROMPT = "Say the animal when you're ready.";
const ANIMALS_SPEECH_OPTIONS = {
  language: "en-US",
  maxUtteranceMs: 11000, // allow longer utterances for this game
  // Keep the microphone open for a full 10s on each attempt before timing out.
  postSilenceMs: 10000,
  minPostSilenceMs: 10000
};

let animalSequence = [];
let currentIndex = 0;
let correctCount = 0;
let attemptCount = 0;
let recognizing = false;
let lastWrongVariantSound = null;
let lastOneMoreTimeSound = null;
let lastPreQuestionFolder = null;
let preQuestionFolderStreak = 0;

let sttEnabled = false;
let sttFatalError = false;

let progressEl;
let statusEl;
let feedbackEl;
let finalScoreEl;
let backToHomeBtn;
let restartGameBtn;
let animalImageEl;

let soundCorrectEl;
let soundWrongEl;
let soundWinEl;
let soundLoseEl;
let soundCorrectVariantEls = [];
let soundWrongVariantEls = [];
let soundOneMoreTimeEls = [];
let soundPreQuestionRootEls = [];
let soundPreQuestionAnimalEls = [];
let animalCelebrationEls = {};
let animalEffectEls = {};
let lastAnimalCelebrationSound = {};
let currentOrientation = "portrait";
let currentAnimalEntry = null;

const audioCache = new Map();
const ORIENTATION_QUERY = "(orientation: landscape)";

function getOrientation() {
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia(ORIENTATION_QUERY).matches ? "landscape" : "portrait";
  }
  if (typeof window !== "undefined") {
    return window.innerWidth > window.innerHeight ? "landscape" : "portrait";
  }
  return "portrait";
}

function getAnimalImagePath(animal, imageNumber, orientation) {
  if (!animal) return "";
  const base = (animal.base || animal.name || "").toLowerCase();
  if (!base) return "";
  const variant = Number.isFinite(imageNumber) ? imageNumber : 1;
  const suffix = orientation === "landscape" ? "l" : "p";
  return `img/animals/${base}_${suffix}${variant}.webp`;
}

function setAnimalImageForOrientation(animal, imageNumber, orientation) {
  if (!animalImageEl) return;
  const imagePath = getAnimalImagePath(animal, imageNumber, orientation);
  if (!imagePath) return;
  const currentSrc = animalImageEl.getAttribute("src");
  if (currentSrc !== imagePath) {
    animalImageEl.setAttribute("src", imagePath);
  }
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
    for (let i = 1; i <= ANIMAL_IMAGE_VARIANTS; i++) {
      imagePool.push({
        animal,
        imageNumber: i,
        imageKey: `${animal.base || animal.name}-${i}`
      });
    }
  });

  const animalCounts = new Map();
  const result = [];
  let lastAnimalName = null;
  const usedImages = new Set();

  while (result.length < TOTAL_ROUNDS) {
    const availablePool = imagePool.filter(
      (entry) =>
        !usedImages.has(entry.imageKey) && (animalCounts.get(entry.animal.name) || 0) < MAX_ANIMAL_OCCURRENCES
    );

    if (!availablePool.length) break;

    const preferred = availablePool.filter((entry) => entry.animal.name !== lastAnimalName);
    const shuffledPool = shuffleArray(preferred.length ? preferred : availablePool);
    const entry = shuffledPool[0];

    result.push({
      ...entry.animal,
      imageNumber: entry.imageNumber
    });
    animalCounts.set(entry.animal.name, (animalCounts.get(entry.animal.name) || 0) + 1);
    lastAnimalName = entry.animal.name;
    usedImages.add(entry.imageKey);
  }

  return result;
}

function getAudioElement(source) {
  if (!source) return null;
  if (typeof HTMLAudioElement !== "undefined" && source instanceof HTMLAudioElement) {
    source.preload = "auto";
    source.muted = false;
    source.volume = 1.0;
    return source;
  }

  if (audioCache.has(source)) return audioCache.get(source);

  const audio = new Audio(source);
  audio.preload = "auto";
  audio.muted = false;
  audio.volume = 1.0;
  audioCache.set(source, audio);
  return audio;
}

function primeAudioElements(elements) {
  (elements || []).filter(Boolean).forEach((el) => {
    try {
      el.preload = "auto";
      if (typeof el.load === "function") {
        el.load();
      }
    } catch (e) {
      console.warn("audio preload failed:", e);
    }
  });
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

function playSoundPromise(elOrSrc) {
  return new Promise((resolve) => {
    playSound(elOrSrc, resolve);
  });
}

function playAudioSequence(sequence, onComplete) {
  const list = (sequence || []).filter(Boolean);

  const playNext = (index) => {
    if (index >= list.length) {
      if (typeof onComplete === "function") onComplete();
      return;
    }
    playSound(list[index], () => playNext(index + 1));
  };

  playNext(0);
}

function playCorrectSequence(correct, variant, celebration, effect, onComplete) {
  const correctEl = getAudioElement(correct);
  const durationMs =
    correctEl && Number.isFinite(correctEl.duration) && correctEl.duration > 0
      ? Math.round(correctEl.duration * 1000)
      : CORRECT_SOUND_DURATION_MS;

  playSound(correctEl);
  const overlapDelayMs = Math.max(durationMs - CORRECT_VARIANT_OVERLAP_MS, 0);
  setTimeout(() => {
    playAudioSequence([variant, celebration, effect], onComplete);
  }, overlapDelayMs);
}

function chooseRandomSound(pool, lastSound) {
  if (!Array.isArray(pool) || !pool.length) return null;
  const filtered = pool.filter((item) => item && item !== lastSound);
  const selectionPool = filtered.length ? filtered : pool.filter(Boolean);
  if (!selectionPool.length) return null;
  const idx = Math.floor(Math.random() * selectionPool.length);
  return selectionPool[idx];
}

function pickPreQuestionSound({ isGameStart } = {}) {
  const hasRoot = soundPreQuestionRootEls.length > 0;
  const hasAnimals = soundPreQuestionAnimalEls.length > 0;
  if (!hasRoot && !hasAnimals) return null;

  let allowedFolders = [];
  if (isGameStart && hasAnimals) {
    allowedFolders = ["animals"];
  } else {
    if (hasRoot) allowedFolders.push("root");
    if (hasAnimals) allowedFolders.push("animals");
    if (preQuestionFolderStreak >= 2 && lastPreQuestionFolder) {
      allowedFolders = allowedFolders.filter((f) => f !== lastPreQuestionFolder);
    }
    if (!allowedFolders.length) {
      if (hasRoot) allowedFolders.push("root");
      if (hasAnimals) allowedFolders.push("animals");
    }
  }

  const folder = allowedFolders[Math.floor(Math.random() * allowedFolders.length)];
  const pool = folder === "animals" ? soundPreQuestionAnimalEls : soundPreQuestionRootEls;
  const sound = chooseRandomSound(pool);

  if (folder === lastPreQuestionFolder) {
    preQuestionFolderStreak += 1;
  } else {
    lastPreQuestionFolder = folder;
    preQuestionFolderStreak = 1;
  }

  return sound;
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

function initAnimalsGame() {
  progressEl = document.getElementById("animalsProgress");
  statusEl = document.getElementById("animalsStatus");
  feedbackEl = document.getElementById("animalsFeedback");
  finalScoreEl = document.getElementById("finalScore");
  backToHomeBtn = document.getElementById("backToHomeBtn");
  restartGameBtn = document.getElementById("restartGameBtn");
  animalImageEl = document.getElementById("animalImage");

  soundCorrectEl = document.getElementById("soundCorrect");
  soundWrongEl = document.getElementById("soundWrong");
  soundWinEl = document.getElementById("soundWin");
  soundLoseEl = document.getElementById("soundLose");
  soundCorrectVariantEls = [
    "audio/correct_v1.mp3",
    "audio/correct_v2.mp3",
    "audio/correct_v3.mp3",
    "audio/correct_v4.mp3",
    "audio/correct_v5.mp3"
  ].map(getAudioElement);
  soundWrongVariantEls = ["audio/wrong_v1.mp3", "audio/wrong_v2.mp3", "audio/wrong_v3.mp3"].map(
    getAudioElement
  );
  soundOneMoreTimeEls = [
    "audio/one_more_time1.mp3",
    "audio/one_more_time2.mp3",
    "audio/one_more_time3.mp3"
  ].map(getAudioElement);
  soundPreQuestionRootEls = ["audio/pre_question1.mp3", "audio/pre_question2.mp3", "audio/pre_question3.mp3"].map(
    getAudioElement
  );
  soundPreQuestionAnimalEls = [
    "audio/animals/pre_question1.mp3",
    "audio/animals/pre_question2.mp3",
    "audio/animals/pre_question3.mp3"
  ].map(getAudioElement);

  ANIMALS.forEach((animal) => {
    const key = animal.name;
    const base = (animal.name || "").toLowerCase();
    animalCelebrationEls[key] = [
      `audio/animals/${base}_cv1.mp3`,
      `audio/animals/${base}_cv2.mp3`,
      `audio/animals/${base}_cv3.mp3`
    ].map(getAudioElement);
    animalEffectEls[key] = getAudioElement(`audio/animals/${base}_e.wav`);
  });

  primeAudioElements([
    soundCorrectEl,
    soundWrongEl,
    soundWinEl,
    soundLoseEl,
    ...soundCorrectVariantEls,
    ...soundWrongVariantEls,
    ...soundOneMoreTimeEls,
    ...soundPreQuestionRootEls,
    ...soundPreQuestionAnimalEls,
    ...Object.values(animalCelebrationEls).flat(),
    ...Object.values(animalEffectEls)
  ]);

  [soundCorrectEl, soundWrongEl, soundWinEl, soundLoseEl].forEach((el) => {
    if (el) {
      el.muted = false;
      el.volume = 1.0;
    }
  });

  if (!progressEl || !statusEl || !feedbackEl || !finalScoreEl || !animalImageEl) {
    console.error("Animals screen elements not found.");
    return;
  }

  currentOrientation = getOrientation();
  const orientationQuery = window.matchMedia ? window.matchMedia(ORIENTATION_QUERY) : null;
  const handleOrientationChange = () => {
    const nextOrientation = getOrientation();
    if (nextOrientation === currentOrientation) return;
    currentOrientation = nextOrientation;
    if (!currentAnimalEntry) return;
    const imageNumber = currentAnimalEntry.imageNumber || 1;
    setAnimalImageForOrientation(currentAnimalEntry, imageNumber, currentOrientation);
  };

  if (orientationQuery && typeof orientationQuery.addEventListener === "function") {
    orientationQuery.addEventListener("change", handleOrientationChange);
  } else if (orientationQuery && typeof orientationQuery.addListener === "function") {
    orientationQuery.addListener(handleOrientationChange);
  } else {
    window.addEventListener("resize", handleOrientationChange);
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
  lastWrongVariantSound = null;
  lastOneMoreTimeSound = null;
  lastPreQuestionFolder = null;
  preQuestionFolderStreak = 0;
  lastAnimalCelebrationSound = {};
  currentOrientation = getOrientation();

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
        startListeningForCurrentAnimal();
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
  }
}

function updateUIForCurrentAnimal() {
  attemptCount = 0;

  const total = animalSequence.length;
  const displayIndex = Math.min(currentIndex + 1, total);
  const sequenceAnimal = animalSequence[currentIndex];
  const fallbackAnimal = ANIMALS[0]
    ? { ...ANIMALS[0], imageNumber: 1 }
    : null;
  const animal = sequenceAnimal || fallbackAnimal;
  const imageNumber = animal && animal.imageNumber ? animal.imageNumber : 1;
  currentAnimalEntry = animal;
  currentOrientation = getOrientation();

  progressEl.textContent = `${displayIndex} / ${total}`;
  setAnimalImageForOrientation(animal, imageNumber, currentOrientation);
  animalImageEl.alt = (animal && animal.name) || "Animal";
  feedbackEl.textContent = "";
  feedbackEl.style.color = "";
}

function startListeningForCurrentAnimal(options = {}) {
  const skipPreQuestion = !!options.skipPreQuestion;
  const isFirstAttempt = attemptCount === 0;

  if (!sttEnabled || sttFatalError || !window.LimeTunaSpeech || !window.cordova) {
    statusEl.textContent = "Speech engine not available.";
    return;
  }

  if (recognizing) {
    console.log("Already recognizing; ignoring extra start.");
    return;
  }

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

    recognizing = true;
    statusEl.textContent = ANIMALS_STATUS_PROMPT;

    try {
      LimeTunaSpeech.startLetter(
        animal.name,
        function (result) {
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
          } else {
            handleIncorrect({ reason: "wrong", animal });
          }
        },
        function (err) {
          recognizing = false;
          const code = parseErrorCode(err);
          console.error("LimeTunaSpeech.startLetter error (animals):", err, "code=", code);

          if (code === "NO_MATCH") {
            statusEl.textContent = "We couldn't hear that clearly. Try again.";
            handleIncorrect({ reason: "no_match", animal });
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
        }
      );
    } catch (err) {
      console.error("LimeTunaSpeech.startLetter threw synchronously (animals)", err);
      recognizing = false;
      statusEl.textContent = "Speech start failed. Retrying…";
      retryOrAdvance();
    }
  };

  if (!skipPreQuestion && isFirstAttempt) {
    const preSound = pickPreQuestionSound({ isGameStart: currentIndex === 0 });
    if (preSound) {
      playSound(preSound, beginListening);
      return;
    }
  }

  beginListening();
}

function handleCorrect(animal) {
  feedbackEl.textContent = "✓ Correct!";
  feedbackEl.style.color = "#2e7d32";
  statusEl.textContent = ANIMALS_STATUS_PROMPT;

  correctCount++;

  const variant = chooseRandomSound(soundCorrectVariantEls);
  const celebrationPool = animalCelebrationEls[animal.name] || [];
  const lastCelebration = lastAnimalCelebrationSound[animal.name];
  const celebration = chooseRandomSound(celebrationPool, lastCelebration);
  if (celebration) lastAnimalCelebrationSound[animal.name] = celebration;
  const effect = animalEffectEls[animal.name];
  playCorrectSequence(soundCorrectEl, variant, celebration, effect, () => {
    advanceToNextAnimal();
  });
}

function handleIncorrect(options = {}) {
  const reason = options.reason || "wrong";
  const animal = options.animal || animalSequence[currentIndex];
  attemptCount++;

  const isRetry = attemptCount < MAX_ATTEMPTS_PER_ANIMAL;
  const isFirstAttempt = attemptCount === 1;

  if (isRetry) {
    feedbackEl.textContent = "✕ Try again!";
    feedbackEl.style.color = "#c62828";
    statusEl.textContent = ANIMALS_STATUS_PROMPT;

    if (reason === "no_match") {
      const useAnimalEffect = Math.random() < 0.5;
      const effect = animal ? animalEffectEls[animal.name] : null;
      let retrySound = null;

      if (useAnimalEffect && effect) {
        retrySound = effect;
      } else {
        retrySound = chooseRandomSound(soundOneMoreTimeEls, lastOneMoreTimeSound);
        if (retrySound) lastOneMoreTimeSound = retrySound;
      }

      playSound(retrySound, () => {
        startListeningForCurrentAnimal({ skipPreQuestion: true });
      });
    } else {
      const wrongVariant = isFirstAttempt
        ? chooseRandomSound(soundWrongVariantEls, lastWrongVariantSound)
        : null;
      if (wrongVariant) lastWrongVariantSound = wrongVariant;
      playAudioSequence([soundWrongEl, wrongVariant], () => {
        startListeningForCurrentAnimal({ skipPreQuestion: true });
      });
    }
  } else {
    feedbackEl.textContent = "✕ Wrong answer.";
    feedbackEl.style.color = "#c62828";
    statusEl.textContent = ANIMALS_STATUS_PROMPT;

    if (reason === "no_match") {
      advanceToNextAnimal();
    } else {
      playSound(soundWrongEl, () => {
        advanceToNextAnimal();
      });
    }
  }
}

function retryOrAdvance() {
  attemptCount++;

  if (attemptCount < MAX_ATTEMPTS_PER_ANIMAL) {
    startListeningForCurrentAnimal({ skipPreQuestion: true });
  } else {
    advanceToNextAnimal();
  }
}

function advanceToNextAnimal(options) {
  const skipListening = options && options.skipListening;

  currentIndex++;

  if (currentIndex >= animalSequence.length) {
    endGame();
  } else {
    updateUIForCurrentAnimal();
    if (sttEnabled && !sttFatalError && window.LimeTunaSpeech && window.cordova && !skipListening) {
      startListeningForCurrentAnimal();
    } else if (skipListening) {
      setTimeout(() => advanceToNextAnimal({ skipListening: true }), 300);
    }
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

  if (correctCount >= 8) {
    playSound(soundWinEl);
  } else {
    playSound(soundLoseEl);
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
