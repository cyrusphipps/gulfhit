// Define your "games" here – easy to expand later.
const LIMETUNA_GAMES = [
  { id: "letters", name: "Letters", icon: "🔤" },
  { id: "numbers", name: "Numbers", icon: "🔢" },
  { id: "colors", name: "Colors", icon: "🎨" },
  { id: "shapes", name: "Shapes", icon: "🔺" },
  { id: "animals", name: "Animals", icon: "🐾" },
  { id: "reset-progress", name: "Reset Progress", icon: "♻️" }
  // Comment some out if you want fewer tiles.
];

const ANIMALS_PROGRESS_STORAGE_KEY = "gulfhit.animals.progress";
const ANIMALS_UNLOCKS_STORAGE_KEY = "gulfhit.animals.unlocks";

let animalsTileSound = null;

function initLimetunaPortal() {
  const gridEl = document.getElementById("tilesGrid");
  const modalOverlay = document.getElementById("modalOverlay");
  const modalTitleEl = document.getElementById("modalTitle");
  const modalBodyEl = document.getElementById("modalBody");
  const modalCloseBtn = document.getElementById("modalCloseBtn");

  if (!gridEl) {
    console.error("tilesGrid element not found");
    return;
  }

  animalsTileSound = new Audio("audio/animals/letsplay.mp3");
  animalsTileSound.preload = "auto";
  animalsTileSound.muted = false;
  animalsTileSound.volume = 1.0;

  LIMETUNA_GAMES.forEach((game, index) => {
    const tileBtn = document.createElement("button");
    tileBtn.className = "game-tile";
    tileBtn.type = "button";

    tileBtn.innerHTML = `
      <span class="tile-icon">${game.icon}</span>
      <span class="tile-label">${game.name}</span>
    `;

    tileBtn.addEventListener("click", () => {
      console.log("Selected:", game.id);

      if (game.id === "letters") {
        window.location.href = "letters.html";
      } else if (game.id === "animals") {
        const goToAnimals = () => {
          window.location.href = "animals.html";
        };

        if (animalsTileSound) {
          animalsTileSound.currentTime = 0;
          const onEnd = () => {
            animalsTileSound.removeEventListener("ended", onEnd);
            goToAnimals();
          };
          animalsTileSound.addEventListener("ended", onEnd);

          const p = animalsTileSound.play();
          if (p && typeof p.then === "function") {
            p.catch(() => {
              animalsTileSound.removeEventListener("ended", onEnd);
              goToAnimals();
            });
          } else {
            goToAnimals();
          }
        } else {
          goToAnimals();
        }
      } else if (game.id === "reset-progress") {
        resetAnimalsProgress();
        openResetModal();
      } else {
        // For now, keep other tiles as simple modals
        openGameModal(game, index);
      }
    });

    gridEl.appendChild(tileBtn);
  });

  function openGameModal(game, index) {
    if (!modalOverlay) return;

    const appNumber = index + 1;
    modalTitleEl.textContent = game.name;
    modalBodyEl.textContent = `You started App #${appNumber}: ${game.name}`;
    modalOverlay.classList.remove("hidden");
  }

  function openResetModal() {
    if (!modalOverlay) return;
    modalTitleEl.textContent = "Progress reset";
    modalBodyEl.textContent =
      "All animal progress has been reset to level 1. Only group 1 animals are unlocked.";
    modalOverlay.classList.remove("hidden");
  }

  function closeGameModal() {
    if (!modalOverlay) return;
    modalOverlay.classList.add("hidden");
  }

  if (modalCloseBtn) {
    modalCloseBtn.addEventListener("click", closeGameModal);
  }

  if (modalOverlay) {
    modalOverlay.addEventListener("click", (event) => {
      if (event.target === modalOverlay) {
        closeGameModal();
      }
    });
  }
}

function resetAnimalsProgress() {
  if (!window.localStorage) return;
  try {
    window.localStorage.removeItem(ANIMALS_PROGRESS_STORAGE_KEY);
    window.localStorage.removeItem(ANIMALS_UNLOCKS_STORAGE_KEY);
  } catch (e) {
    console.warn("Unable to reset animal progress:", e);
  }
}

// Cordova deviceready handling
function onDeviceReady() {
  console.log("Cordova deviceready fired, initializing Gulfhit 1.9.5 portal");
  initLimetunaPortal();
}

document.addEventListener("DOMContentLoaded", function () {
  var toggle = document.getElementById("menuToggle");
  var sideMenu = document.getElementById("sideMenu");
  var backdrop = document.getElementById("sideMenuBackdrop");
  var closeBtn = document.getElementById("menuClose");

  if (!toggle || !sideMenu || !backdrop || !closeBtn) return;

  function openMenu() {
    sideMenu.classList.add("open");
    backdrop.classList.remove("hidden");
  }

  function closeMenu() {
    sideMenu.classList.remove("open");
    backdrop.classList.add("hidden");
  }

  toggle.addEventListener("click", openMenu);
  closeBtn.addEventListener("click", closeMenu);
  backdrop.addEventListener("click", closeMenu);
});

// Support running in browser without Cordova for quick testing
if (window.cordova) {
  document.addEventListener("deviceready", onDeviceReady, false);
} else {
  document.addEventListener("DOMContentLoaded", () => {
    console.log("No Cordova detected, running in browser mode");
    initLimetunaPortal();
  });
}
