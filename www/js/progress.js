const AnimalsData = window.AnimalsData || {};
const {
  ANIMAL_GROUPS = [],
  ANIMAL_IMAGE_VARIANTS = 5,
  ANIMALS_PROGRESS_STORAGE_KEY = "",
  ANIMALS_UNLOCKS_STORAGE_KEY = "",
  getProgressForAnimal = () => 1,
  loadAnimalProgress = () => ({}),
  loadUnlockedAnimals = () => [],
  saveUnlockedAnimals = () => {},
  ensureUnlockedFromProgress = (progress, unlocks) => unlocks || [],
  getUnlockedAnimalsForGame = () => [],
  getAnimalGroupIndex = () => -1
} = AnimalsData;

const FALLBACK_ANIMALS = [
  { name: "Dog" },
  { name: "Cat" },
  { name: "Bird" },
  { name: "Fish" },
  { name: "Horse" }
];

function buildProgressRows() {
  const progress = loadAnimalProgress();
  let unlockedKeys = loadUnlockedAnimals();
  unlockedKeys = ensureUnlockedFromProgress(progress, unlockedKeys);
  if (typeof saveUnlockedAnimals === "function") {
    saveUnlockedAnimals(unlockedKeys);
  }

  let unlockedAnimals = getUnlockedAnimalsForGame(unlockedKeys);
  if ((!unlockedAnimals || !unlockedAnimals.length) && ANIMAL_GROUPS.length) {
    unlockedAnimals = ANIMAL_GROUPS[0];
  }
  if ((!unlockedAnimals || !unlockedAnimals.length) && FALLBACK_ANIMALS.length) {
    unlockedAnimals = FALLBACK_ANIMALS;
  }

  return (unlockedAnimals || []).map((animal) => {
    const level = getProgressForAnimal(progress, animal);
    const groupIndex = typeof getAnimalGroupIndex === "function" ? getAnimalGroupIndex(animal) : -1;
    return {
      name: animal.name,
      level,
      group: groupIndex >= 0 ? groupIndex + 1 : 1
    };
  });
}

function renderProgress() {
  const listEl = document.getElementById("progressList");
  const emptyEl = document.getElementById("progressEmpty");
  const summaryEl = document.getElementById("progressSummary");

  if (!listEl || !emptyEl || !summaryEl) return;

  const rows = buildProgressRows();
  listEl.innerHTML = "";

  if (!rows.length) {
    emptyEl.classList.remove("hidden");
    summaryEl.textContent = "";
    return;
  }

  emptyEl.classList.add("hidden");
  summaryEl.textContent = `Unlocked animals: ${rows.length}`;

  const grouped = rows.reduce((acc, row) => {
    const key = row.group;
    if (!acc[key]) acc[key] = [];
    acc[key].push(row);
    return acc;
  }, {});

  Object.keys(grouped)
    .map((key) => Number(key))
    .sort((a, b) => a - b)
    .forEach((groupNumber) => {
      const section = document.createElement("div");
      section.className = "progress-group";

      const heading = document.createElement("div");
      heading.className = "progress-group-title";
      heading.textContent = `Group ${groupNumber}`;
      section.appendChild(heading);

      grouped[groupNumber].forEach((row) => {
        const item = document.createElement("div");
        item.className = "progress-item";

        const nameEl = document.createElement("div");
        nameEl.className = "progress-item-name";
        nameEl.textContent = row.name;

        const levelEl = document.createElement("div");
        levelEl.className = "progress-item-level";
        levelEl.textContent = `Level ${row.level} / ${ANIMAL_IMAGE_VARIANTS}`;

        item.appendChild(nameEl);
        item.appendChild(levelEl);
        section.appendChild(item);
      });

      listEl.appendChild(section);
    });
}

function initProgressPage() {
  const backBtn = document.getElementById("progressBackBtn");
  if (backBtn) {
    backBtn.addEventListener("click", () => {
      window.location.href = "index.html";
    });
  }

  renderProgress();

  if (typeof window !== "undefined") {
    window.addEventListener("storage", (event) => {
      if (!event) return;
      if (
        event.key === ANIMALS_PROGRESS_STORAGE_KEY ||
        event.key === ANIMALS_UNLOCKS_STORAGE_KEY
      ) {
        renderProgress();
      }
    });
  }

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        renderProgress();
      }
    });
  }
}

document.addEventListener("DOMContentLoaded", () => {
  initProgressPage();
});
