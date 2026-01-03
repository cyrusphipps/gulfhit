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
const MAX_ATTEMPTS_PER_ANIMAL = 2;
const MAX_ANIMAL_OCCURRENCES = 2;
const ANIMALS_STATUS_PROMPT = "Say the animal when you're ready.";
const CORRECT_VARIANT_DELAY_MS = 1000;
const CORRECT_EFFECT_DELAY_MS = 1000;
const ANIMALS_SPEECH_OPTIONS = {
  language: "en-US",
  maxUtteranceMs: 20000, // allow up to 20 seconds per attempt
  postSilenceMs: 20000, // keep listening even if silent
  minPostSilenceMs: 20000
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
let animalVoiceEls = {};
let animalEffectEls = {};

const audioCache = new Map();

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

function playSoundPromise(elOrSrc) {
  return new Promise((resolve) => {
    playSound(elOrSrc, resolve);
  });
}

function playSoundWithDelay(elOrSrc, delayMs) {
  const ms = Math.max(0, delayMs || 0);
  return new Promise((resolve) => {
    setTimeout(() => {
      playSound(elOrSrc, resolve);
    }, ms);
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

  soundCorrectEl = document.getElementById("soundCorrect");
  soundWrongEl = document.getElementById("soundWrong");
  soundWinEl = document.getElementById("soundWin");
  soundLoseEl = document.getElementById("soundLose");
  soundCorrectVariantEls = ["audio/correct_v1.mp3", "audio/correct_v2.mp3", "audio/correct_v3.mp3"].map(
    getAudioElement
  );
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
    animalVoiceEls[key] = getAudioElement(`audio/animals/${base}_v.mp3`);
    animalEffectEls[key] = getAudioElement(`audio/animals/${base}_e.wav`);
  });

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
            handleIncorrect({ reason: "wrong" });
          }
        },
        function (err) {
          recognizing = false;
          const code = parseErrorCode(err);
          console.error("LimeTunaSpeech.startLetter error (animals):", err, "code=", code);

          if (code === "NO_MATCH") {
            statusEl.textContent = "We couldn't hear that clearly. Try again.";
            handleIncorrect({ reason: "no_match" });
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
  const voice = animalVoiceEls[animal.name];
  const effect = animalEffectEls[animal.name];

  const plays = [];
  plays.push(playSoundWithDelay(soundCorrectEl, 0));
  if (variant) {
    plays.push(playSoundWithDelay(variant, CORRECT_VARIANT_DELAY_MS));
  }

  Promise.all(plays.map((p) => p.catch(() => {})))
    .then(() => playSoundPromise(voice))
    .then(() => playSoundPromise(effect))
    .then(() => {
      advanceToNextAnimal();
    });
}

function handleIncorrect(options = {}) {
  const reason = options.reason || "wrong";
  attemptCount++;

  const isRetry = attemptCount < MAX_ATTEMPTS_PER_ANIMAL;
  const isFirstAttempt = attemptCount === 1;

  if (isRetry) {
    feedbackEl.textContent = "✕ Try again!";
    feedbackEl.style.color = "#c62828";
    statusEl.textContent = ANIMALS_STATUS_PROMPT;

    if (reason === "no_match") {
      const retrySound = chooseRandomSound(soundOneMoreTimeEls, lastOneMoreTimeSound);
      if (retrySound) lastOneMoreTimeSound = retrySound;
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
