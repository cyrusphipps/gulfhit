const ANIMAL_GROUPS = [
  [
    {
      name: "Bird",
      base: "bird"
    },
    {
      name: "Cat",
      base: "cat"
    },
    {
      name: "Dog",
      base: "dog"
    },
    {
      name: "Fish",
      base: "fish"
    },
    {
      name: "Horse",
      base: "horse"
    }
  ],
  [
    {
      name: "Spider",
      base: "spider"
    }
  ]
];

const ANIMALS_PROGRESS_STORAGE_KEY = "gulfhit.animals.progress";
const ANIMALS_CORRECT_COUNTS_STORAGE_KEY = "gulfhit.animals.correctCounts";
const ANIMAL_IMAGE_VARIANTS = 5;

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

function buildProgressRow(animal, progressMap, countsMap) {
  const row = document.createElement("tr");
  const nameCell = document.createElement("td");
  nameCell.textContent = animal.name;

  const correctCell = document.createElement("td");
  const key = getAnimalKey(animal);
  const count = countsMap && Object.prototype.hasOwnProperty.call(countsMap, key) ? Number(countsMap[key]) : 0;
  correctCell.textContent = Number.isFinite(count) && count > 0 ? String(count) : "0";

  const levelCell = document.createElement("td");
  const level = getProgressForAnimal(progressMap, animal);
  levelCell.textContent = `${level} / ${ANIMAL_IMAGE_VARIANTS}`;

  row.append(nameCell, correctCell, levelCell);
  return row;
}

function renderProgressTable() {
  const summaryEl = document.getElementById("progressSummary");
  const tableBody = document.getElementById("progressTableBody");
  if (!tableBody) return;

  const progressMap = loadStoredJson(ANIMALS_PROGRESS_STORAGE_KEY, {});
  const countsMap = loadStoredJson(ANIMALS_CORRECT_COUNTS_STORAGE_KEY, {});

  tableBody.innerHTML = "";

  let totalCorrect = 0;
  ANIMALS.forEach((animal) => {
    tableBody.appendChild(buildProgressRow(animal, progressMap, countsMap));
    const key = getAnimalKey(animal);
    const count = countsMap && Object.prototype.hasOwnProperty.call(countsMap, key) ? Number(countsMap[key]) : 0;
    if (Number.isFinite(count)) {
      totalCorrect += count;
    }
  });

  if (summaryEl) {
    summaryEl.textContent = `Total correct answers: ${totalCorrect}`;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  renderProgressTable();

  const backBtn = document.getElementById("backToHomeBtn");
  if (backBtn) {
    backBtn.addEventListener("click", () => {
      window.location.href = "index.html";
    });
  }
});
