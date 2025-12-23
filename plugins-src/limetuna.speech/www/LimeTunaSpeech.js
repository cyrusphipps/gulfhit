var exec = require('cordova/exec');

// Phonetic map based on how kids tend to say letters
const PHONETIC_MAP = {
  A: ["a", "ay", "eh", "ei"],
  B: ["b", "bee", "be"],
  C: ["c", "see", "cee", "sea"],
  D: ["d", "dee"],
  E: ["e", "ee"],
  F: ["f", "ef"],
  G: ["g", "gee"],
  H: ["h", "aitch"],
  I: ["i", "eye", "aye"],
  J: ["j", "jay"],
  K: ["k", "kay"],
  L: ["l", "el"],
  M: ["m", "em"],
  N: ["n", "en"],
  O: ["o", "oh"],
  P: ["p", "pee"],
  Q: ["q", "cue", "queue"],
  R: ["r", "ar"],
  S: ["s", "ess"],
  T: ["t", "tee"],
  U: ["u", "you", "yu", "yoo"],
  V: ["v", "vee"],
  W: ["w", "double you", "double-u"],
  X: ["x", "ex"],
  Y: ["y", "why"],
  Z: ["z", "zee", "zed"]
};

function normalizePhrase(str) {
  return (str || "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Score how well a spoken phrase matches a particular letter.
 * Higher is better.
 */
function scorePhraseForLetter(phrase, letter) {
  if (!phrase) return 0;
  if (!letter) return 0;

  const norm = normalizePhrase(phrase);
  if (!norm) return 0;

  const forms = PHONETIC_MAP[letter];
  if (!forms) return 0;

  const words = norm.split(" ");

  let best = 0;

  // Exact phonetic match of whole phrase
  for (const f of forms) {
    if (norm === f) {
      best = Math.max(best, 4);
    }
  }

  // Any word matches a form
  for (const w of words) {
    for (const f of forms) {
      if (w === f) {
        best = Math.max(best, 3);
      } else if (f.startsWith(w) || w.startsWith(f)) {
        best = Math.max(best, 2);
      }
    }
  }

  // Single-character phrase case, e.g. "b"
  if (norm.length === 1 && norm[0] === letter.toLowerCase()) {
    best = Math.max(best, 4);
  }

  // Very short phrase that starts with the letter
  if (norm.length <= 3 && norm[0] === letter.toLowerCase()) {
    best = Math.max(best, 2);
  }

  return best;
}

/**
 * Given all results + expected letter, pick the best letter A–Z or null.
 */
function chooseLetterFromResults(allResults, expectedLetter) {
  const candidates = Array.isArray(allResults) && allResults.length > 0
    ? allResults
    : [""];

  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  const expectedUpper = (expectedLetter || "").toUpperCase();

  let bestLetter = null;
  let bestScore = 0;

  for (const L of letters) {
    let letterScore = 0;

    for (const phrase of candidates) {
      letterScore = Math.max(letterScore, scorePhraseForLetter(phrase, L));
    }

    if (letterScore <= 0) continue;

    // Bias toward the expected letter
    if (L === expectedUpper) {
      letterScore += 1.0;
    }

    if (letterScore > bestScore) {
      bestScore = letterScore;
      bestLetter = L;
    }
  }

  // Require a minimum score to accept anything
  if (bestScore >= 2) {
    return bestLetter;
  }
  return null;
}

var LimeTunaSpeech = (function () {
  var _opts = {
    language: "en-US"
  };
  var _initialized = false;

  function init(options, onSuccess, onError) {
    _opts = Object.assign({}, _opts, options || {});

    exec(
      function () {
        _initialized = true;
        console.log("[LimeTunaSpeech] init success");
        if (typeof onSuccess === "function") onSuccess();
      },
      function (err) {
        console.error("[LimeTunaSpeech] init error:", err);
        if (typeof onError === "function") onError(err);
      },
      "LimeTunaSpeech",
      "init",
      [_opts]
    );
  }

  /**
   * expectedLetter: single letter A–Z (upper or lower)
   */
  function startLetter(expectedLetter, onResult, onError) {
    if (!_initialized) {
      console.warn("[LimeTunaSpeech] startLetter called before init()");
    }

    exec(
      function (nativePayload) {
        try {
          var obj = {};
          if (typeof nativePayload === "string") {
            obj = JSON.parse(nativePayload);
          } else if (nativePayload && typeof nativePayload === "object") {
            obj = nativePayload;
          }

          var rawText = obj.text || "";
          var allResults = Array.isArray(obj.allResults) ? obj.allResults.slice() : [];
          if (allResults.length === 0 && rawText) {
            allResults = [rawText];
          }

          var normalizedLetter = chooseLetterFromResults(allResults, expectedLetter);

          var result = {
            text: rawText,
            normalizedLetter: normalizedLetter,
            confidence:
              typeof obj.confidence === "number" ? obj.confidence : null,
            allResults: allResults,
            allConfidences: Array.isArray(obj.allConfidences)
              ? obj.allConfidences
              : null
          };

          console.log("[LimeTunaSpeech] result:", result);

          if (typeof onResult === "function") {
            onResult(result);
          }
        } catch (e) {
          console.error("[LimeTunaSpeech] result parse error:", e);
          if (typeof onError === "function") {
            onError(e);
          }
        }
      },
      function (err) {
        console.error("[LimeTunaSpeech] startLetter error:", err);
        if (typeof onError === "function") {
          try {
            if (typeof err === "string" && err.startsWith("{")) {
              onError(JSON.parse(err));
            } else {
              onError(err);
            }
          } catch (e) {
            onError(err);
          }
        }
      },
      "LimeTunaSpeech",
      "startLetter",
      [expectedLetter || ""]
    );
  }

  function stop(onSuccess, onError) {
    exec(
      function () {
        if (typeof onSuccess === "function") onSuccess();
      },
      function (err) {
        if (typeof onError === "function") onError(err);
      },
      "LimeTunaSpeech",
      "stop",
      []
    );
  }

  function setBeepsMuted(muted, onSuccess, onError) {
    exec(
      function () {
        if (typeof onSuccess === "function") onSuccess();
      },
      function (err) {
        if (typeof onError === "function") onError(err);
      },
      "LimeTunaSpeech",
      "setBeepsMuted",
      [!!muted]
    );
  }

  function setKeepScreenOn(keepOn, onSuccess, onError) {
    exec(
      function () {
        if (typeof onSuccess === "function") onSuccess();
      },
      function (err) {
        if (typeof onError === "function") onError(err);
      },
      "LimeTunaSpeech",
      "setKeepScreenOn",
      [!!keepOn]
    );
  }

  return {
    init: init,
    startLetter: startLetter,
    stop: stop,
    setBeepsMuted: setBeepsMuted,
    setKeepScreenOn: setKeepScreenOn
  };
})();

window.LimeTunaSpeech = LimeTunaSpeech;
module.exports = LimeTunaSpeech;
