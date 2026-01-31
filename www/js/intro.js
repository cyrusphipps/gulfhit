const introAudio = document.getElementById("introAudio");
const introPlayBtn = document.getElementById("introPlayBtn");

let resumeAudioOnInteraction = null;

function startIntroAudio() {
  if (!introAudio) return;
  introAudio.loop = true;
  const playPromise = introAudio.play();

  if (playPromise && typeof playPromise.then === "function") {
    playPromise.catch(() => {
      resumeAudioOnInteraction = () => {
        introAudio.play().catch(() => {});
        window.removeEventListener("click", resumeAudioOnInteraction);
        window.removeEventListener("touchstart", resumeAudioOnInteraction);
      };
      window.addEventListener("click", resumeAudioOnInteraction, { once: true });
      window.addEventListener("touchstart", resumeAudioOnInteraction, { once: true });
    });
  }
}

function stopIntroAudio() {
  if (!introAudio) return;
  introAudio.pause();
  introAudio.currentTime = 0;
}

document.addEventListener("DOMContentLoaded", () => {
  startIntroAudio();

  if (introPlayBtn) {
    introPlayBtn.addEventListener("click", () => {
      stopIntroAudio();
      window.location.href = "index.html";
    });
  }
});
