const ANIMAL_GROUPS = [
  [
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
      name: "Bird",
      base: "bird",
      keywords: ["bird", "parrot"]
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
      name: "Chicken",
      base: "chicken",
      keywords: ["chicken", "hen", "rooster"]
    },
    {
      name: "Cow",
      base: "cow",
      keywords: ["cow", "cattle"]
    },
    {
      name: "Duck",
      base: "duck",
      keywords: ["duck"]
    },
    {
      name: "Pig",
      base: "pig",
      keywords: ["pig", "piggy"]
    },
    {
      name: "Sheep",
      base: "sheep",
      keywords: ["sheep", "lamb"]
    }
  ],
  [
    {
      name: "Ant",
      base: "ant",
      keywords: ["ant"]
    },
    {
      name: "Bee",
      base: "bee",
      keywords: ["bee", "bees"]
    },
    {
      name: "Butterfly",
      base: "butterfly",
      keywords: ["butterfly"]
    },
    {
      name: "Lizard",
      base: "lizard",
      keywords: ["lizard", "gecko"]
    },
    {
      name: "Spider",
      base: "spider",
      keywords: ["spider"]
    }
  ],
  [
    {
      name: "Elephant",
      base: "elephant",
      keywords: ["elephant"]
    },
    {
      name: "Giraffe",
      base: "giraffe",
      keywords: ["giraffe"]
    },
    {
      name: "Lion",
      base: "lion",
      keywords: ["lion"]
    },
    {
      name: "Monkey",
      base: "monkey",
      keywords: ["monkey"]
    },
    {
      name: "Zebra",
      base: "zebra",
      keywords: ["zebra"]
    }
  ],
  [
    {
      name: "Dolphin",
      base: "dolphin",
      keywords: ["dolphin"]
    },
    {
      name: "Octopus",
      base: "octopus",
      keywords: ["octopus"]
    },
    {
      name: "Shark",
      base: "shark",
      keywords: ["shark"]
    },
    {
      name: "Turtle",
      base: "turtle",
      keywords: ["turtle"]
    },
    {
      name: "Whale",
      base: "whale",
      keywords: ["whale"]
    }
  ]
];

const ANIMAL_IMAGE_VARIANTS = 5;
const MASTERED_THRESHOLD = 3;
const ANIMALS = ANIMAL_GROUPS.flat();

const ANIMALS_DB_NAME = "gulfhit-animals.db";
const ANIMALS_DB_KEY = "gulfhit-local-progress-v1";
const ANIMALS_PROGRESS_STORAGE_KEY = "gulfhit.animals.progress.v2";

let dbPromise = null;

function getAnimalKey(animal) {
  return (animal && (animal.base || animal.name) ? animal.base || animal.name : "")
    .toLowerCase()
    .trim();
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

function defaultProgressEntry(animal) {
  const groupIndex = getAnimalGroupIndex(animal);
  return {
    correctCount: 0,
    mastered: false,
    unlocked: groupIndex === 0
  };
}

function normalizeProgressMap(progressMap) {
  const normalized = {};
  ANIMALS.forEach((animal) => {
    const key = getAnimalKey(animal);
    const entry = progressMap && progressMap[key] ? progressMap[key] : {};
    const defaults = defaultProgressEntry(animal);
    normalized[key] = {
      correctCount: Number.isFinite(entry.correctCount) ? entry.correctCount : defaults.correctCount,
      mastered: Boolean(entry.mastered || entry.correctCount >= MASTERED_THRESHOLD),
      unlocked: Boolean(entry.unlocked || defaults.unlocked)
    };
  });
  return normalized;
}

function getProgressForAnimal(progressMap, animal) {
  const key = getAnimalKey(animal);
  if (!progressMap || !progressMap[key]) return defaultProgressEntry(animal);
  return progressMap[key];
}

function getUnlockedAnimalsForGame(progressMap) {
  const normalized = normalizeProgressMap(progressMap || {});
  return ANIMALS.filter((animal) => normalized[getAnimalKey(animal)].unlocked);
}

function hasSqlCipher() {
  return typeof window !== "undefined" && window.cordova && window.sqlitePlugin;
}

function openDatabase() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    try {
      const db = window.sqlitePlugin.openDatabase({
        name: ANIMALS_DB_NAME,
        location: "default",
        key: ANIMALS_DB_KEY
      });
      resolve(db);
    } catch (e) {
      reject(e);
    }
  });
  return dbPromise;
}

function runSql(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.executeSql(
      sql,
      params,
      (res) => resolve(res),
      (err) => reject(err)
    );
  });
}

async function initAnimalsStorage() {
  if (!hasSqlCipher()) return null;
  const db = await openDatabase();

  await runSql(
    db,
    "CREATE TABLE IF NOT EXISTS animals (animal_id TEXT PRIMARY KEY, display_name TEXT, group_number INTEGER)"
  );
  await runSql(
    db,
    "CREATE TABLE IF NOT EXISTS progress (animal_id TEXT PRIMARY KEY, correct_count INTEGER NOT NULL DEFAULT 0, mastered INTEGER NOT NULL DEFAULT 0, unlocked INTEGER NOT NULL DEFAULT 0, last_updated INTEGER)"
  );

  await Promise.all(
    ANIMALS.map((animal) =>
      runSql(
        db,
        "INSERT OR IGNORE INTO animals (animal_id, display_name, group_number) VALUES (?, ?, ?)",
        [getAnimalKey(animal), animal.name, getAnimalGroupIndex(animal) + 1]
      )
    )
  );

  await Promise.all(
    ANIMALS.map((animal) =>
      runSql(
        db,
        "INSERT OR IGNORE INTO progress (animal_id, correct_count, mastered, unlocked, last_updated) VALUES (?, 0, 0, ?, ?)",
        [
          getAnimalKey(animal),
          getAnimalGroupIndex(animal) === 0 ? 1 : 0,
          Date.now()
        ]
      )
    )
  );

  await runSql(
    db,
    "UPDATE progress SET unlocked = 1 WHERE animal_id IN (SELECT animal_id FROM animals WHERE group_number = 1)"
  );

  return db;
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

async function loadAnimalProgress() {
  if (hasSqlCipher()) {
    const db = await initAnimalsStorage();
    const result = await runSql(
      db,
      "SELECT animal_id, correct_count, mastered, unlocked FROM progress"
    );
    const progress = {};
    for (let i = 0; i < result.rows.length; i++) {
      const row = result.rows.item(i);
      progress[row.animal_id] = {
        correctCount: row.correct_count || 0,
        mastered: Boolean(row.mastered),
        unlocked: Boolean(row.unlocked)
      };
    }
    return normalizeProgressMap(progress);
  }

  const stored = loadStoredJson(ANIMALS_PROGRESS_STORAGE_KEY, {});
  return normalizeProgressMap(stored);
}

async function persistProgressMap(progressMap) {
  const normalized = normalizeProgressMap(progressMap);
  if (hasSqlCipher()) {
    const db = await initAnimalsStorage();
    const now = Date.now();
    await Promise.all(
      Object.entries(normalized).map(([key, entry]) =>
        runSql(
          db,
          "UPDATE progress SET correct_count = ?, mastered = ?, unlocked = ?, last_updated = ? WHERE animal_id = ?",
          [entry.correctCount, entry.mastered ? 1 : 0, entry.unlocked ? 1 : 0, now, key]
        )
      )
    );
  } else {
    saveStoredJson(ANIMALS_PROGRESS_STORAGE_KEY, normalized);
  }
  return normalized;
}

function unlockRandomFromNextGroup(progressMap, animal) {
  const normalized = normalizeProgressMap(progressMap);
  const groupIndex = getAnimalGroupIndex(animal);
  const nextGroup = ANIMAL_GROUPS[groupIndex + 1];
  if (!nextGroup || !nextGroup.length) return { progress: normalized, unlockedKey: null };

  const locked = nextGroup.filter((entry) => !normalized[getAnimalKey(entry)].unlocked);
  if (!locked.length) return { progress: normalized, unlockedKey: null };

  const selection = locked[Math.floor(Math.random() * locked.length)];
  const selectionKey = getAnimalKey(selection);
  normalized[selectionKey] = {
    ...normalized[selectionKey],
    unlocked: true
  };

  return { progress: normalized, unlockedKey: selectionKey };
}

async function recordCorrectAnswer(animal, progressMap) {
  const normalized = normalizeProgressMap(progressMap || {});
  const key = getAnimalKey(animal);
  const current = normalized[key] || defaultProgressEntry(animal);
  const nextCount = Math.min(current.correctCount + 1, MASTERED_THRESHOLD);
  const masteredNow = !current.mastered && nextCount >= MASTERED_THRESHOLD;

  normalized[key] = {
    ...current,
    correctCount: nextCount,
    mastered: current.mastered || nextCount >= MASTERED_THRESHOLD
  };

  let updatedProgress = normalized;
  let unlockedKey = null;

  if (masteredNow) {
    const unlockResult = unlockRandomFromNextGroup(updatedProgress, animal);
    updatedProgress = unlockResult.progress;
    unlockedKey = unlockResult.unlockedKey;
  }

  await persistProgressMap(updatedProgress);

  return { progress: updatedProgress, unlockedKey, masteredNow };
}

async function resetAnimalProgress() {
  const resetMap = normalizeProgressMap({});
  await persistProgressMap(resetMap);
  return resetMap;
}

window.AnimalsData = {
  ANIMAL_GROUPS,
  ANIMAL_IMAGE_VARIANTS,
  MASTERED_THRESHOLD,
  ANIMALS,
  ANIMALS_PROGRESS_STORAGE_KEY,
  getAnimalKey,
  getAnimalGroupIndex,
  getProgressForAnimal,
  getUnlockedAnimalsForGame,
  loadAnimalProgress,
  recordCorrectAnswer,
  resetAnimalProgress,
  initAnimalsStorage
};
