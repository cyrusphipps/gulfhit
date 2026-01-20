const AnimalsData = window.AnimalsData || {};
const {
  ANIMAL_GROUPS = [],
  MASTERED_THRESHOLD = 3,
  getAnimalKey = () => "",
  getProgressForAnimal = () => ({ correctCount: 0, mastered: false, unlocked: false }),
  loadAnimalProgress = async () => ({}),
  getUnlockedAnimalsForGame = () => []
} = AnimalsData;

async function buildProgressRows() {
  const progress = await loadAnimalProgress();
  const unlockedAnimals = getUnlockedAnimalsForGame(progress);
  const unlockedSet = new Set(unlockedAnimals.map((animal) => getAnimalKey(animal)));
  const rows = [];

  ANIMAL_GROUPS.forEach((group, groupIndex) => {
    const unlockedAnimals = group.filter((animal, index) => {
      if (groupIndex === 0) return true;
      return unlockedSet.has(getAnimalKey(animal));
    });

    if (!unlockedAnimals.length) return;

    unlockedAnimals.forEach((animal) => {
      const entry = getProgressForAnimal(progress, animal);
      rows.push({
        name: animal.name,
        correctCount: entry.correctCount || 0,
        mastered: entry.mastered,
        group: groupIndex + 1
      });
    });
  });

  return rows;
}

async function renderProgress() {
  const listEl = document.getElementById("progressList");
  const emptyEl = document.getElementById("progressEmpty");
  const summaryEl = document.getElementById("progressSummary");

  if (!listEl || !emptyEl || !summaryEl) return;

  const rows = await buildProgressRows();
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
        levelEl.textContent = row.mastered
          ? "Mastered ✓"
          : `Correct ${row.correctCount} / ${MASTERED_THRESHOLD}`;

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

  renderProgress().catch((e) => console.error("Unable to render progress:", e));
}

document.addEventListener("DOMContentLoaded", () => {
  initProgressPage();
});
