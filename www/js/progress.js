const AnimalsData = window.AnimalsData || {};
const {
  ANIMAL_GROUPS = [],
  ANIMAL_IMAGE_VARIANTS = 5,
  getAnimalKey = () => "",
  getProgressForAnimal = () => 1,
  loadAnimalProgress = () => ({}),
  loadUnlockedAnimals = () => [],
  ensureUnlockedFromProgress = (progress, unlocks) => unlocks || []
} = AnimalsData;

function buildProgressRows() {
  const progress = loadAnimalProgress();
  const unlockedKeys = ensureUnlockedFromProgress(progress, loadUnlockedAnimals());
  const unlockedSet = new Set((unlockedKeys || []).map((key) => String(key).toLowerCase()));

  const rows = [];

  ANIMAL_GROUPS.forEach((group, groupIndex) => {
    const unlockedAnimals = group.filter((animal, index) => {
      if (groupIndex === 0) return true;
      return unlockedSet.has(getAnimalKey(animal));
    });

    if (!unlockedAnimals.length) return;

    unlockedAnimals.forEach((animal) => {
      const level = getProgressForAnimal(progress, animal);
      rows.push({
        name: animal.name,
        level,
        group: groupIndex + 1
      });
    });
  });

  return rows;
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
}

document.addEventListener("DOMContentLoaded", () => {
  initProgressPage();
});
