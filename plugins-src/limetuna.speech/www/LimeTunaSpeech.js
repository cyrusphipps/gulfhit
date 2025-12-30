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
  N: ["n", "en", "in", "inn", "ehn"],
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
      var lowConfidenceBonus = letterScore <= 2 ? 1.5 : 1.0;
      letterScore += 1.0 * lowConfidenceBonus;
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

function runInternalChecks() {
  try {
    if (!console || typeof console.assert !== "function") return;

    var scoredN = scorePhraseForLetter("in", "N");
    console.assert(
      scoredN >= 3,
      "[LimeTunaSpeech] scorePhraseForLetter should recognize 'in' as N, got",
      scoredN
    );

    var chosenN = chooseLetterFromResults(["in"], "n");
    console.assert(
      chosenN === "N",
      "[LimeTunaSpeech] chooseLetterFromResults should resolve 'in' to N when expected=N, got",
      chosenN
    );
  } catch (err) {
    if (console && typeof console.error === "function") {
      console.error("[LimeTunaSpeech] internal checks failed:", err);
    }
  }
}

runInternalChecks();

var LimeTunaSpeech = (function () {
  var _opts = {
    language: "en-US"
  };
  var _initialized = false;
  var _attemptRmsHistory = new Map();
  var _attemptThresholdLogged = new Set();
  var RMS_HISTORY_LIMIT = 40;

  function formatRms(value) {
    return typeof value === "number" ? value.toFixed(2) : String(value);
  }

  function recordRmsSample(attemptId, value) {
    if (attemptId === null || attemptId === undefined) return;
    var samples = _attemptRmsHistory.get(attemptId) || [];
    samples.push(value);
    if (samples.length > RMS_HISTORY_LIMIT) {
      samples.shift();
    }
    _attemptRmsHistory.set(attemptId, samples);
  }

  function logThresholdsForAttempt(evt) {
    var attemptId = evt && typeof evt.attempt_id === "number" ? evt.attempt_id : null;
    var thresholds = evt && evt.timing && evt.timing.native_thresholds;
    if (!attemptId || !thresholds) return;
    if (_attemptThresholdLogged.has(attemptId)) return;
    _attemptThresholdLogged.add(attemptId);
    console.info(
      "[LimeTunaSpeech] attempt " + attemptId +
      " thresholds start=" + thresholds.rms_start_threshold_db +
      " end=" + thresholds.rms_end_threshold_db +
      " postSilenceMs=" + thresholds.post_silence_ms +
      " maxUtteranceMs=" + thresholds.max_utterance_ms +
      " baseline=" + (thresholds.baseline_rms_db !== undefined ? thresholds.baseline_rms_db : "n/a")
    );
  }

  function logCommitDebug(evt) {
    var extras = evt && evt.extras ? evt.extras : {};
    var attemptId = evt && typeof evt.attempt_id === "number" ? evt.attempt_id : null;
    if (!attemptId) return;
    if (!extras.commit_reason && !(evt && typeof evt.event === "string" && evt.event.indexOf("commit") !== -1)) {
      return;
    }
    var thresholds = evt && evt.timing && evt.timing.native_thresholds ? evt.timing.native_thresholds : {};
    var tail = Array.isArray(extras.rms_tail)
      ? extras.rms_tail.slice()
      : (_attemptRmsHistory.get(attemptId) || []).slice();
    var formattedTail = tail.map(formatRms).join(", ");
    console.log(
      "[LimeTunaSpeech][debug] attempt " + attemptId +
      " commit=" + (extras.commit_reason || evt.event || "unknown") +
      " tail=[" + formattedTail + "]" +
      " baseline=" + (thresholds.baseline_rms_db !== undefined ? thresholds.baseline_rms_db : "n/a") +
      " start=" + thresholds.rms_start_threshold_db +
      " end=" + thresholds.rms_end_threshold_db +
      " postSilenceMs=" + thresholds.post_silence_ms +
      " maxUtteranceMs=" + thresholds.max_utterance_ms
    );
  }

  function cleanupAttempt(attemptId) {
    if (attemptId === null || attemptId === undefined) return;
    _attemptRmsHistory.delete(attemptId);
    _attemptThresholdLogged.delete(attemptId);
  }

  function init(options, onSuccess, onError) {
    _opts = Object.assign({}, _opts, options || {});
    var sanitizedOpts = Object.assign({}, _opts);
    Object.keys(sanitizedOpts).forEach(function (key) {
      if (sanitizedOpts[key] === undefined || sanitizedOpts[key] === null) {
        delete sanitizedOpts[key];
      }
    });

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
      [sanitizedOpts]
    );
  }

  /**
   * expectedLetter: single letter A–Z (upper or lower)
   */
  function startLetter(
    expectedLetter,
    onResult,
    onError,
    onRmsUpdate,
    onDebugEvent
  ) {
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

          if (obj && obj.type === "rms") {
            if (typeof onRmsUpdate === "function") {
              onRmsUpdate(obj);
            }
            if (typeof obj.attempt_id === "number") {
              recordRmsSample(obj.attempt_id, obj.rms_db);
            }
            return;
          }

          if (obj && obj.type === "event") {
            console.log("[LimeTunaSpeech] milestone:", obj);
            logThresholdsForAttempt(obj);
            logCommitDebug(obj);
            if (typeof onDebugEvent === "function") {
              onDebugEvent(obj);
            }
            return;
          }

          var rawText = obj.text || "";
          var allResults = Array.isArray(obj.allResults) ? obj.allResults.slice() : [];
          if (allResults.length === 0 && rawText) {
            allResults = [rawText];
          }
          var timing = obj.timing || null;

          var normalizedLetter = chooseLetterFromResults(allResults, expectedLetter);

          var result = {
            text: rawText,
            normalizedLetter: normalizedLetter,
            confidence:
              typeof obj.confidence === "number" ? obj.confidence : null,
            allResults: allResults,
            allConfidences: Array.isArray(obj.allConfidences)
              ? obj.allConfidences
              : null,
            timing: timing,
            attemptId: typeof obj.attempt_id === "number" ? obj.attempt_id : null,
            expectedLetter: obj.expected_letter || expectedLetter || null
          };

          console.log("[LimeTunaSpeech] result:", result);

          if (typeof onResult === "function") {
            onResult(result);
          }
          if (result.attemptId !== null) {
            cleanupAttempt(result.attemptId);
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
        var parsedErr = err;
        if (typeof onError === "function") {
          try {
            if (typeof err === "string" && err.startsWith("{")) {
              parsedErr = JSON.parse(err);
            }
            onError(parsedErr);
          } catch (e) {
            onError(err);
          }
        }
        if (parsedErr && typeof parsedErr.attempt_id === "number") {
          cleanupAttempt(parsedErr.attempt_id);
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

  /**
   * Explicitly tear down and recreate the native SpeechRecognizer.
   * Recommended retry flow when you see ENGINE_RESTART_REQUIRED or busy errors:
   *   1) call resetRecognizer
   *   2) then retry startLetter once reset completes
   */
  function resetRecognizer(onSuccess, onError) {
    exec(
      function () {
        if (typeof onSuccess === "function") onSuccess();
      },
      function (err) {
        if (typeof onError === "function") onError(err);
      },
      "LimeTunaSpeech",
      "resetRecognizer",
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
    resetRecognizer: resetRecognizer,
    setBeepsMuted: setBeepsMuted,
    setKeepScreenOn: setKeepScreenOn
  };
})();

window.LimeTunaSpeech = LimeTunaSpeech;
module.exports = LimeTunaSpeech;
