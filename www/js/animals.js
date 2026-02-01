// animals.js – animal speech game

const ANIMAL_GROUPS = [
  [
    {
      name: "Cat",
      base: "cat",
      group: 1,
      keywords: ["cat", "kitten"]
    },
    {
      name: "Dog",
      base: "dog",
      group: 1,
      keywords: ["dog", "puppy"]
    },
    {
      name: "Bird",
      base: "bird",
      group: 1,
      keywords: ["bird", "parrot"]
    },
    {
      name: "Fish",
      base: "fish",
      group: 1,
      keywords: ["fish"]
    },
    {
      name: "Horse",
      base: "horse",
      group: 1,
      keywords: ["horse", "pony"]
    },
    {
      name: "Spider",
      base: "spider",
      group: 1,
      keywords: ["spider"]
    }
  ],
  [
    {
      name: "Bear",
      base: "bear",
      group: 2,
      keywords: ["bear"]
    },
    {
      name: "Lizard",
      base: "lizard",
      group: 2,
      keywords: ["lizard"]
    },
    {
      name: "Bee",
      base: "bee",
      group: 2,
      keywords: ["bee"]
    },
    {
      name: "Dolphin",
      base: "dolphin",
      group: 2,
      keywords: ["dolphin"]
    },
    {
      name: "Frog",
      base: "frog",
      group: 2,
      keywords: ["frog"]
    },
    {
      name: "Duck",
      base: "duck",
      group: 2,
      keywords: ["duck"]
    }
  ],
  [
    {
      name: "Ladybug",
      base: "ladybug",
      group: 3,
      keywords: ["ladybug", "lady bug"]
    },
    {
      name: "Lion",
      base: "lion",
      group: 3,
      keywords: ["lion"]
    },
    {
      name: "Monkey",
      base: "monkey",
      group: 3,
      keywords: ["monkey"]
    },
    {
      name: "Mouse",
      base: "mouse",
      group: 3,
      keywords: ["mouse"]
    },
    {
      name: "Panda",
      base: "panda",
      group: 3,
      keywords: ["panda"]
    },
    {
      name: "Chicken",
      base: "chicken",
      group: 3,
      keywords: ["chicken"]
    }
  ],
  [
    {
      name: "Cow",
      base: "cow",
      group: 4,
      keywords: ["cow"]
    },
    {
      name: "Elephant",
      base: "elephant",
      group: 4,
      keywords: ["elephant"]
    },
    {
      name: "Orca",
      base: "orca",
      group: 4,
      keywords: ["orca", "killer whale"]
    },
    {
      name: "Penguin",
      base: "penguin",
      group: 4,
      keywords: ["penguin"]
    },
    {
      name: "Shark",
      base: "shark",
      group: 4,
      keywords: ["shark"]
    },
    {
      name: "Rabbit",
      base: "rabbit",
      group: 4,
      keywords: ["rabbit", "bunny"]
    }
  ],
  [
    {
      name: "Zebra",
      base: "zebra",
      group: 5,
      keywords: ["zebra"]
    },
    {
      name: "Goat",
      base: "goat",
      group: 5,
      keywords: ["goat"]
    },
    {
      name: "Pig",
      base: "pig",
      group: 5,
      keywords: ["pig"]
    },
    {
      name: "Snake",
      base: "snake",
      group: 5,
      keywords: ["snake"]
    },
    {
      name: "Tiger",
      base: "tiger",
      group: 5,
      keywords: ["tiger"]
    },
    {
      name: "Turtle",
      base: "turtle",
      group: 5,
      keywords: ["turtle"]
    }
  ]
];

const ACTIVE_GROUP_COUNT = ANIMAL_GROUPS.length;
const TOTAL_ROUNDS = 6;
const MAX_ATTEMPTS_PER_ANIMAL = 2;
const ANIMAL_IMAGE_VARIANTS = 5;
const MAX_ANIMAL_LEVEL = 6;
const ANIMALS_STATUS_PROMPT = "";
const ANIMALS_SPEECH_OPTIONS = {
  language: "en-US",
  maxUtteranceMs: 11000, // allow longer utterances for this game
  // Keep the microphone open for a full 10s on each attempt before timing out.
  postSilenceMs: 10000,
  minPostSilenceMs: 10000
};

const ANIMALS_PROGRESS_STORAGE_KEY = "gulfhit.animals.progress";
const ANIMALS_UNLOCKS_STORAGE_KEY = "gulfhit.animals.unlocks";
const ANIMALS_CORRECT_COUNTS_STORAGE_KEY = "gulfhit.animals.correctCounts";
const ANIMALS_UNLOCK_STREAK_STORAGE_KEY = "gulfhit.animals.unlockStreak";
const MIN_CORRECT_FOR_UNLOCK = 5;
const ACTIVE_GROUPS = ANIMAL_GROUPS.slice(0, ACTIVE_GROUP_COUNT);
const ANIMALS = ACTIVE_GROUPS.flat();

let animalSequence = [];
let currentIndex = 0;
let correctCount = 0;
let attemptCount = 0;
let recognizing = false;
let lastWrongVariantSound = null;
let lastOneMoreTimeSound = null;
let lastCorrectVariantSound = null;
let lastPreQuestionFolder = null;
let preQuestionFolderStreak = 0;

let sttEnabled = false;
let sttFatalError = false;

let progressEl;
let progressSummaryEl;
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
let soundLevelUpEl;
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
let animalProgress = {};
let unlockedAnimalKeys = [];
let animalCorrectCounts = {};
let currentAttemptToken = 0;
let unlockStreakCount = 0;
let unlockModalEl;
let unlockModalNameEl;
let unlockModalImageEl;
let unlockModalCloseEl;
let unlockedAnimalForModal = null;

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
  const group = Number.isFinite(animal.group) ? animal.group : 1;
  const groupPrefix = `g${group}`;
  const variant = Number.isFinite(imageNumber) ? imageNumber : 1;
  const suffix = orientation === "landscape" ? "l" : "p";
  return `img/animals/${groupPrefix}_${base}_${suffix}${variant}.webp`;
}

function getAnimalKey(animal) {
  return (animal && (animal.base || animal.name) ? animal.base || animal.name : "")
    .toLowerCase()
    .trim();
}

function getUnlockKeySet(unlocks) {
  return new Set((unlocks || []).map((key) => String(key).toLowerCase()));
}

function isAnimalUnlocked(animal, unlockedSet) {
  const group = Number.isFinite(animal && animal.group) ? animal.group : 1;
  if (group <= 1) return true;
  if (!unlockedSet) return false;
  return unlockedSet.has(getAnimalKey(animal));
}

function getProgressForAnimal(progressMap, animal, unlockedSet) {
  if (unlockedSet && !isAnimalUnlocked(animal, unlockedSet)) return 0;
  const key = getAnimalKey(animal);
  const raw = progressMap && Object.prototype.hasOwnProperty.call(progressMap, key) ? progressMap[key] : 1;
  const level = Number(raw);
  if (!Number.isFinite(level) || level < 1) return 1;
  if (level > MAX_ANIMAL_LEVEL) return MAX_ANIMAL_LEVEL;
  return level;
}

function getImageNumberForAnimal(animal, progressMap) {
  const level = getProgressForAnimal(progressMap, animal);
  if (level >= ANIMAL_IMAGE_VARIANTS) {
    return Math.floor(Math.random() * ANIMAL_IMAGE_VARIANTS) + 1;
  }
  return level;
}

function loadStoredJson(key, fallback) {
  if (typeof window === "undefined" || !window.localStorage) return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed || fallback;
  } catch (e) {
    console.warn("Storage load failed:", e);
    return fallback;
  }
}

function saveStoredJson(key, value) {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn("Storage save failed:", e);
  }
}

function loadAnimalProgress(unlocks) {
  const stored = loadStoredJson(ANIMALS_PROGRESS_STORAGE_KEY, {});
  const unlockedSet = getUnlockKeySet(unlocks);
  const normalized = {};
  ANIMALS.forEach((animal) => {
    const key = getAnimalKey(animal);
    normalized[key] = getProgressForAnimal(stored, animal, unlockedSet);
  });
  return normalized;
}

function loadAnimalCorrectCounts() {
  const stored = loadStoredJson(ANIMALS_CORRECT_COUNTS_STORAGE_KEY, {});
  const normalized = {};
  ANIMALS.forEach((animal) => {
    const key = getAnimalKey(animal);
    const raw = stored && Object.prototype.hasOwnProperty.call(stored, key) ? stored[key] : 0;
    const count = Number(raw);
    normalized[key] = Number.isFinite(count) && count > 0 ? count : 0;
  });
  return normalized;
}

function loadUnlockStreakCount() {
  const raw = loadStoredJson(ANIMALS_UNLOCK_STREAK_STORAGE_KEY, 0);
  const count = Number(raw);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function loadUnlockedAnimals() {
  const stored = loadStoredJson(ANIMALS_UNLOCKS_STORAGE_KEY, []);
  if (!Array.isArray(stored)) return [];
  return stored.map((key) => String(key).toLowerCase());
}

function saveAnimalProgress(progress) {
  saveStoredJson(ANIMALS_PROGRESS_STORAGE_KEY, progress);
}

function saveAnimalCorrectCounts(counts) {
  saveStoredJson(ANIMALS_CORRECT_COUNTS_STORAGE_KEY, counts);
}

function saveUnlockStreakCount(count) {
  saveStoredJson(ANIMALS_UNLOCK_STREAK_STORAGE_KEY, count);
}

function saveUnlockedAnimals(unlocks) {
  saveStoredJson(ANIMALS_UNLOCKS_STORAGE_KEY, unlocks);
}

function ensureUnlockedFromProgress(progress, unlocks) {
  const nextUnlocks = new Set((unlocks || []).map((key) => String(key).toLowerCase()));
  const validKeys = new Set(
    ANIMAL_GROUPS.flat().map((animal) => getAnimalKey(animal)).filter((key) => key)
  );
  return Array.from(nextUnlocks).filter((key) => validKeys.has(key));
}

function isGroupFullyUnlocked(groupNumber, unlocks) {
  if (groupNumber <= 1) return true;
  const group = ANIMAL_GROUPS[groupNumber - 1];
  if (!group || !group.length) return true;
  const unlockedKeys = new Set((unlocks || []).map((key) => String(key).toLowerCase()));
  return group.every((animal) => unlockedKeys.has(getAnimalKey(animal)));
}

function getLockedAnimalsInGroup(groupNumber, unlocks) {
  const group = ANIMAL_GROUPS[groupNumber - 1] || [];
  const unlockedKeys = new Set((unlocks || []).map((key) => String(key).toLowerCase()));
  return group.filter((animal) => !unlockedKeys.has(getAnimalKey(animal)));
}

function getUnlockStage(unlocks) {
  if (!isGroupFullyUnlocked(2, unlocks)) {
    return { groupNumber: 2, requiredStreak: 1 };
  }
  if (!isGroupFullyUnlocked(3, unlocks)) {
    return { groupNumber: 3, requiredStreak: 2 };
  }
  if (!isGroupFullyUnlocked(4, unlocks)) {
    return { groupNumber: 4, requiredStreak: 3 };
  }
  if (!isGroupFullyUnlocked(5, unlocks)) {
    return { groupNumber: 5, requiredStreak: 4 };
  }
  return null;
}

function unlockOneAnimalInGroup(unlocks, groupNumber) {
  const nextUnlocks = new Set((unlocks || []).map((key) => String(key).toLowerCase()));
  const locked = getLockedAnimalsInGroup(groupNumber, Array.from(nextUnlocks));
  if (!locked.length) return { unlocks: Array.from(nextUnlocks), unlockedAnimal: null };
  const selection = shuffleArray(locked)[0];
  if (selection) {
    nextUnlocks.add(getAnimalKey(selection));
  }
  return { unlocks: Array.from(nextUnlocks), unlockedAnimal: selection || null };
}

function getUnlockedAnimalsForGame(unlocks) {
  const unlockedKeys = new Set((unlocks || []).map((key) => String(key).toLowerCase()));
  const unlockedAnimals = [];

  ANIMAL_GROUPS.forEach((group, index) => {
    if (index >= ACTIVE_GROUP_COUNT) return;
    if (index === 0) {
      unlockedAnimals.push(...group);
      return;
    }

    group.forEach((animal) => {
      if (unlockedKeys.has(getAnimalKey(animal))) {
        unlockedAnimals.push(animal);
      }
    });
  });

  return unlockedAnimals;
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

function updateUnlockModalImage() {
  if (!unlockModalImageEl || !unlockedAnimalForModal) return;
  const orientation = getOrientation();
  const imagePath = getAnimalImagePath(unlockedAnimalForModal, 1, orientation);
  if (imagePath) {
    unlockModalImageEl.setAttribute("src", imagePath);
  }
}

function showUnlockModal(animal) {
  if (!unlockModalEl || !unlockModalNameEl || !unlockModalImageEl || !animal) return;
  unlockedAnimalForModal = animal;
  unlockModalNameEl.textContent = animal.name || "";
  updateUnlockModalImage();
  unlockModalEl.classList.remove("hidden");
}

function hideUnlockModal() {
  if (!unlockModalEl) return;
  unlockModalEl.classList.add("hidden");
  unlockedAnimalForModal = null;
}

function shuffleArray(arr) {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function buildAnimalSequence(availableAnimals) {
  const pool = shuffleArray((availableAnimals || []).slice());
  return pool.slice(0, TOTAL_ROUNDS);
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
  if (correctEl) {
    playSound(correctEl);
    setTimeout(() => {
      playAudioSequence([variant, celebration, effect], onComplete);
    }, 1000);
    return;
  }
  playAudioSequence([variant, celebration, effect], onComplete);
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
  progressSummaryEl = document.getElementById("animalsProgressSummary");
  statusEl = document.getElementById("animalsStatus");
  feedbackEl = document.getElementById("animalsFeedback");
  finalScoreEl = document.getElementById("finalScore");
  backToHomeBtn = document.getElementById("backToHomeBtn");
  restartGameBtn = document.getElementById("restartGameBtn");
  animalImageEl = document.getElementById("animalImage");
  unlockModalEl = document.getElementById("unlockModal");
  unlockModalNameEl = document.getElementById("unlockAnimalName");
  unlockModalImageEl = document.getElementById("unlockAnimalImage");
  unlockModalCloseEl = document.getElementById("unlockModalClose");

  soundCorrectEl = document.getElementById("soundCorrect");
  soundWrongEl = document.getElementById("soundWrong");
  soundWinEl = document.getElementById("soundWin");
  soundLoseEl = document.getElementById("soundLose");
  soundLevelUpEl = document.getElementById("soundLevelUp");
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
    animalEffectEls[key] = getAudioElement(`audio/animals/${base}_e.mp3`);
  });

  primeAudioElements([
    soundCorrectEl,
    soundWrongEl,
    soundWinEl,
    soundLoseEl,
    soundLevelUpEl,
    ...soundCorrectVariantEls,
    ...soundWrongVariantEls,
    ...soundOneMoreTimeEls,
    ...soundPreQuestionRootEls,
    ...soundPreQuestionAnimalEls,
    ...Object.values(animalCelebrationEls).flat(),
    ...Object.values(animalEffectEls)
  ]);

  [soundCorrectEl, soundWrongEl, soundWinEl, soundLoseEl, soundLevelUpEl].forEach((el) => {
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
    if (unlockModalEl && !unlockModalEl.classList.contains("hidden")) {
      updateUnlockModalImage();
    }
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

  if (unlockModalCloseEl) {
    unlockModalCloseEl.addEventListener("click", () => {
      hideUnlockModal();
    });
  }
  if (unlockModalImageEl) {
    unlockModalImageEl.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!unlockedAnimalForModal) return;
      const effectSound = animalEffectEls[unlockedAnimalForModal.name];
      if (effectSound) {
        playSound(effectSound);
      }
    });
  }
  if (unlockModalEl) {
    unlockModalEl.addEventListener("click", (event) => {
      if (event.target === unlockModalEl) {
        hideUnlockModal();
      }
    });
  }

  startNewGame();
}

function startNewGame() {
  unlockedAnimalKeys = loadUnlockedAnimals();
  animalProgress = loadAnimalProgress(unlockedAnimalKeys);
  animalCorrectCounts = loadAnimalCorrectCounts();
  unlockedAnimalKeys = ensureUnlockedFromProgress(animalProgress, unlockedAnimalKeys);
  unlockStreakCount = loadUnlockStreakCount();
  const availableAnimals = getUnlockedAnimalsForGame(unlockedAnimalKeys);
  animalSequence = buildAnimalSequence(availableAnimals);
  currentIndex = 0;
  correctCount = 0;
  attemptCount = 0;
  recognizing = false;
  sttFatalError = false;
  lastWrongVariantSound = null;
  lastOneMoreTimeSound = null;
  lastCorrectVariantSound = null;
  lastPreQuestionFolder = null;
  preQuestionFolderStreak = 0;
  lastAnimalCelebrationSound = {};
  currentOrientation = getOrientation();
  hideUnlockModal();

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
  const imageNumber = getImageNumberForAnimal(animal, animalProgress);
  currentAnimalEntry = animal ? { ...animal, imageNumber } : animal;
  currentOrientation = getOrientation();

  progressEl.textContent = `${displayIndex} / ${total}`;
  if (progressSummaryEl) {
    const level = getProgressForAnimal(animalProgress, animal);
    progressSummaryEl.textContent = `Level for ${animal.name}: ${level}`;
  }
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
  const attemptToken = (currentAttemptToken += 1);

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
          if (attemptToken !== currentAttemptToken) {
            console.warn("[animals] stale result ignored", { attemptToken, currentAttemptToken });
            return;
          }
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
          if (attemptToken !== currentAttemptToken) {
            console.warn("[animals] stale error ignored", { attemptToken, currentAttemptToken, err });
            return;
          }
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
  const correctKey = getAnimalKey(animal);
  const currentCorrectCount =
    animalCorrectCounts && Object.prototype.hasOwnProperty.call(animalCorrectCounts, correctKey)
      ? animalCorrectCounts[correctKey]
      : 0;
  animalCorrectCounts[correctKey] = (Number.isFinite(currentCorrectCount) ? currentCorrectCount : 0) + 1;
  saveAnimalCorrectCounts(animalCorrectCounts);
  const key = getAnimalKey(animal);
  const currentLevel = getProgressForAnimal(animalProgress, animal);
  if (currentLevel < MAX_ANIMAL_LEVEL) {
    animalProgress[key] = Math.min(currentLevel + 1, MAX_ANIMAL_LEVEL);
    saveAnimalProgress(animalProgress);
  }
  if (progressSummaryEl) {
    const level = getProgressForAnimal(animalProgress, animal);
    progressSummaryEl.textContent = `Level for ${animal.name}: ${level}`;
  }

  const variant = chooseRandomSound(soundCorrectVariantEls, lastCorrectVariantSound);
  if (variant) lastCorrectVariantSound = variant;
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

  let newlyUnlockedAnimal = null;
  const stage = getUnlockStage(unlockedAnimalKeys);
  if (stage) {
    if (correctCount >= MIN_CORRECT_FOR_UNLOCK) {
      unlockStreakCount += 1;
      if (unlockStreakCount >= stage.requiredStreak) {
        const result = unlockOneAnimalInGroup(unlockedAnimalKeys, stage.groupNumber);
        if (result.unlocks.length !== unlockedAnimalKeys.length) {
          unlockedAnimalKeys = result.unlocks;
          saveUnlockedAnimals(unlockedAnimalKeys);
          newlyUnlockedAnimal = result.unlockedAnimal;
        }
        unlockStreakCount = 0;
      }
    } else {
      unlockStreakCount = 0;
    }
  } else {
    unlockStreakCount = 0;
  }
  saveUnlockStreakCount(unlockStreakCount);

  if (restartGameBtn) {
    restartGameBtn.classList.remove("hidden");
  }

  if (window.cordova && window.LimeTunaSpeech) {
    if (LimeTunaSpeech.setKeepScreenOn) {
      LimeTunaSpeech.setKeepScreenOn(false);
    }
    // We keep beeps muted until user leaves with the back button
  }

  const winThreshold = Math.ceil(TOTAL_ROUNDS * 0.8);
  if (correctCount >= winThreshold) {
    playSound(soundWinEl, () => {
      if (newlyUnlockedAnimal) {
        const effectSound = animalEffectEls[newlyUnlockedAnimal.name];
        playAudioSequence([soundLevelUpEl, effectSound]);
        setTimeout(() => {
          showUnlockModal(newlyUnlockedAnimal);
        }, 500);
      }
    });
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
