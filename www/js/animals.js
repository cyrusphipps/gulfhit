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
const CORRECT_SOUND_DURATION_MS = 2000; // correct.wav ~2s
const ANIMALS_SPEECH_OPTIONS = {
  language: "en-US",
  maxUtteranceMs: 7000, // allow longer utterances for this game
  postSilenceMs: 2000,
  minPostSilenceMs: 1200
};

let animalSequence = [];
let currentIndex = 0;
let correctCount = 0;
let attemptCount = 0;
let recognizing = false;

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

  finalScoreEl.classList.add("hidden");
  if (restartGameBtn) restartGameBtn.classList.add("hidden");
  feedbackEl.textContent = "";
  feedbackEl.style.color = "";
  statusEl.textContent = "Get ready to say what you see!";

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
        statusEl.textContent = "Speech ready. Say what you see when you're ready.";
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

function startListeningForCurrentAnimal() {
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

  recognizing = true;
  const attemptNumber = attemptCount + 1;
  statusEl.textContent = `Listening (${attemptNumber}/${MAX_ATTEMPTS_PER_ANIMAL})…`;

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
        statusEl.textContent = isCorrect ? "Nice job!" : "Let's try again.";

        if (isCorrect) {
          handleCorrect();
        } else {
          handleIncorrect();
        }
      },
      function (err) {
        recognizing = false;
        const code = parseErrorCode(err);
        console.error("LimeTunaSpeech.startLetter error (animals):", err, "code=", code);

        if (code === "NO_MATCH") {
          statusEl.textContent = "We couldn't hear that clearly. Try again.";
          handleIncorrect();
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
}

function handleCorrect() {
  feedbackEl.textContent = "✓ Correct!";
  feedbackEl.style.color = "#2e7d32";
  statusEl.textContent = "Great job!";

  correctCount++;

  playSound(soundCorrectEl);
  setTimeout(() => {
    advanceToNextAnimal();
  }, CORRECT_SOUND_DURATION_MS);
}

function handleIncorrect() {
  attemptCount++;

  const isRetry = attemptCount < MAX_ATTEMPTS_PER_ANIMAL;

  if (isRetry) {
    feedbackEl.textContent = "✕ Try again!";
    feedbackEl.style.color = "#c62828";
    statusEl.textContent = "Give it another shot.";

    playSound(soundWrongEl, () => {
      startListeningForCurrentAnimal();
    });
  } else {
    feedbackEl.textContent = "✕ Wrong answer.";
    feedbackEl.style.color = "#c62828";
    statusEl.textContent = "Moving to the next one.";

    playSound(soundWrongEl, () => {
      advanceToNextAnimal();
    });
  }
}

function retryOrAdvance() {
  attemptCount++;

  if (attemptCount < MAX_ATTEMPTS_PER_ANIMAL) {
    startListeningForCurrentAnimal();
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
  statusEl.textContent = "Game over.\n" + `You got ${correctCount} out of ${total} animals right.`;
  feedbackEl.textContent = "";
  feedbackEl.style.color = "";

  const msg = `You got ${correctCount} out of ${total} animals right.`;
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
