const ANIMAL_GROUPS = [
  [
    {
      name: "Bird",
      base: "bird",
      keywords: ["bird", "parrot"]
    },
    {
      name: "Cat",
      base: "cat",
      keywords: ["cat", "kitten"]
    },
    {
      name: "Dog",
      base: "dog",
      keywords: ["dog", "puppy"]
    },
    {
      name: "Fish",
      base: "fish",
      keywords: ["fish"]
    },
    {
      name: "Horse",
      base: "horse",
      keywords: ["horse", "pony"]
    }
  ],
  [
    {
      name: "Spider",
      base: "spider",
      keywords: ["spider"]
    }
  ]
];

const ANIMAL_IMAGE_VARIANTS = 5;
const ANIMALS_PROGRESS_STORAGE_KEY = "gulfhit.animals.progress";
const ANIMALS_UNLOCKS_STORAGE_KEY = "gulfhit.animals.unlocks";
const ANIMALS = ANIMAL_GROUPS.flat();

function getAnimalKey(animal) {
  return (animal && (animal.base || animal.name) ? animal.base || animal.name : "")
    .toLowerCase()
    .trim();
}

function getProgressForAnimal(progressMap, animal) {
  const key = getAnimalKey(animal);
  const raw = progressMap && Object.prototype.hasOwnProperty.call(progressMap, key) ? progressMap[key] : 1;
  const level = Number(raw);
  if (!Number.isFinite(level) || level < 1) return 1;
  if (level > ANIMAL_IMAGE_VARIANTS) return ANIMAL_IMAGE_VARIANTS;
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

function loadAnimalProgress() {
  const stored = loadStoredJson(ANIMALS_PROGRESS_STORAGE_KEY, {});
  const normalized = {};
  ANIMALS.forEach((animal) => {
    const key = getAnimalKey(animal);
    normalized[key] = getProgressForAnimal(stored, animal);
  });
  return normalized;
}

function loadUnlockedAnimals() {
  const stored = loadStoredJson(ANIMALS_UNLOCKS_STORAGE_KEY, []);
  if (!Array.isArray(stored)) return [];
  return stored.map((key) => String(key).toLowerCase());
}

function saveAnimalProgress(progress) {
  saveStoredJson(ANIMALS_PROGRESS_STORAGE_KEY, progress);
}

function saveUnlockedAnimals(unlocks) {
  saveStoredJson(ANIMALS_UNLOCKS_STORAGE_KEY, unlocks);
}

function ensureUnlockedFromProgress(progress, unlocks) {
  const nextUnlocks = new Set((unlocks || []).map((key) => String(key).toLowerCase()));

  ANIMAL_GROUPS.forEach((group, index) => {
    const nextGroup = ANIMAL_GROUPS[index + 1];
    if (!nextGroup || !nextGroup.length) return;

    const masteredCount = group.filter((animal) => getProgressForAnimal(progress, animal) >= ANIMAL_IMAGE_VARIANTS)
      .length;
    const currentUnlockedCount = nextGroup.filter((animal) => nextUnlocks.has(getAnimalKey(animal))).length;
    const targetUnlockCount = Math.min(masteredCount, nextGroup.length);
    if (currentUnlockedCount >= targetUnlockCount) return;

    const needed = targetUnlockCount - currentUnlockedCount;
    const toUnlock = nextGroup.filter((animal) => !nextUnlocks.has(getAnimalKey(animal))).slice(0, needed);
    toUnlock.forEach((animal) => nextUnlocks.add(getAnimalKey(animal)));
  });

  return Array.from(nextUnlocks);
}

function getUnlockedAnimalsForGame(unlocks) {
  const unlockedKeys = new Set((unlocks || []).map((key) => String(key).toLowerCase()));
  const unlockedAnimals = [];

  ANIMAL_GROUPS.forEach((group, index) => {
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

function getAnimalGroupIndex(animal) {
  const key = getAnimalKey(animal);
  for (let i = 0; i < ANIMAL_GROUPS.length; i++) {
    if (ANIMAL_GROUPS[i].some((entry) => getAnimalKey(entry) === key)) {
      return i;
    }
  }
  return -1;
}

window.AnimalsData = {
  ANIMAL_GROUPS,
  ANIMAL_IMAGE_VARIANTS,
  ANIMALS_PROGRESS_STORAGE_KEY,
  ANIMALS_UNLOCKS_STORAGE_KEY,
  ANIMALS,
  getAnimalKey,
  getProgressForAnimal,
  loadStoredJson,
  saveStoredJson,
  loadAnimalProgress,
  loadUnlockedAnimals,
  saveAnimalProgress,
  saveUnlockedAnimals,
  ensureUnlockedFromProgress,
  getUnlockedAnimalsForGame,
  getAnimalGroupIndex
};
