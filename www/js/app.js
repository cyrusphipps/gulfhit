// Define your "games" here – easy to expand later.
const LIMETUNA_GAMES = [
  { id: "letters", name: "Letters", icon: "🔤" },
  { id: "numbers", name: "Numbers", icon: "🔢" },
  { id: "colors", name: "Colors", icon: "🎨" },
  { id: "shapes", name: "Shapes", icon: "🔺" },
  { id: "animals", name: "Animals", icon: "🐾" },
  { id: "vehicles", name: "Vehicles", icon: "🚗" }
  // Comment some out if you want fewer tiles.
];

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
        // Navigate to the letters game page
        window.location.href = "letters.html";
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

// Cordova deviceready handling
function onDeviceReady() {
  console.log("Cordova deviceready fired, initializing limetuna portal");
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
