package com.limetuna.speech;

import android.Manifest;
import android.app.Activity;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.util.Log;
import android.view.Window;
import android.view.WindowManager;

import org.apache.cordova.CallbackContext;
import org.apache.cordova.CordovaInterface;
import org.apache.cordova.CordovaPlugin;
import org.apache.cordova.CordovaWebView;
import org.apache.cordova.PermissionHelper;
import org.apache.cordova.PluginResult;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.concurrent.atomic.AtomicReference;

public class LimeTunaSpeech extends CordovaPlugin implements RecognitionListener {

    private static final String TAG = "LimeTunaSpeech";
    private static final int REQ_RECORD_AUDIO = 7001;
    // Debug-only speech indicator thresholds. Keep these in sync with
    // www/js/letters.js so we can retune or remove the indicator together.
    // RMS_VOICE_TRIGGER_DB: first RMS level we count as "speech started" for
    // timing indicator purposes (not an ASR gate).
    private static final float RMS_VOICE_TRIGGER_DB = -2.0f;

    // Start gating is disabled: begin tracking speech immediately and rely only on the end threshold.
    private static final float RMS_START_THRESHOLD_DB = -1000f;
    private static final float RMS_END_THRESHOLD_DB = 2.5f;
    private static final float END_BASELINE_DELTA_PERCENT = 0.45f;
    private static final float END_BASELINE_DELTA_DB_MIN = 2.0f;
    private static final float RMS_RESUME_DELTA_DB = 0.6f;
    private static final long POST_SILENCE_MS = 1300L;
    private static final long NO_PARTIAL_POST_SILENCE_BOOST_MS = 350L;
    private static final long MIN_POST_SILENCE_MS = 450L;
    private static final long MAX_UTTERANCE_MS = 3800L;
    private static final float NO_PARTIAL_END_THRESHOLD_DELTA_DB = 0.4f;
    private static final int ZERO_RMS_STREAK_THRESHOLD = 12;
    private static final int RMS_SMOOTH_TAIL_SAMPLES = 8;
    private static final long SILENCE_HOLD_MS = 340L;

    private SpeechRecognizer speechRecognizer;
    private CallbackContext currentCallback;

    private String language = "en-US";
    private ComponentName recognizerServiceOverride = null;

    private Handler handler;
    private boolean isListening = false;

    // Runtime permission during init()
    private CallbackContext pendingInitCallback;

    // Beep muting: we ONLY touch system-ish streams, never MUSIC
    private AudioManager audioManager;
    private int originalSystemVolume = -1;
    private int originalNotificationVolume = -1;
    private int originalRingVolume = -1;
    private boolean volumesMuted = false;

    private ListeningState listeningState = ListeningState.IDLE;
    private Runnable silenceTimeoutRunnable;
    private Runnable speechFailSafeRunnable;
    private boolean stopIssued = false;
    private ArrayList<String> lastPartialResults = null;

    private AttemptTiming currentTiming;
    private long attemptCounter = 0L;
    private float sessionPeakRmsDb = Float.NEGATIVE_INFINITY;
    private float adaptiveEndThresholdDb = RMS_END_THRESHOLD_DB;
    private RmsStats rmsStats = new RmsStats();
    private long lastRmsDispatchMs = 0L;
    private static final long RMS_DISPATCH_INTERVAL_MS = 80L;
    private static final float RMS_AVG_ALPHA = 0.2f;
    private boolean recognizerResetPending = false;
    private int consecutiveZeroRmsWindows = 0;
    private long belowEndThresholdSinceMs = 0L;
    private boolean partialResultsSeen = false;
    private boolean awaitingPartialAfterBos = false;
    private long lastComputedPostSilenceDelayMs = POST_SILENCE_MS;
    private float lastComputedEndThresholdDb = RMS_END_THRESHOLD_DB;
    private final AtomicReference<ThresholdConfig> thresholdConfig =
            new AtomicReference<>(ThresholdConfig.defaults());

    private enum ListeningState {
        IDLE,
        SPEECH,
        SILENCE_WINDOW,
        COMMIT
    }

    private static class RmsStats {
        float lastRmsDb = Float.NaN;
        float smoothedRmsDb = Float.NaN;
        float avgRmsDb = Float.NaN;
        float minRmsDb = Float.NaN;
        float maxRmsDb = Float.NaN;
        long lastUpdateMs = 0L;
        private static final int MAX_RECENT_SAMPLES = 40;
        ArrayDeque<Float> recentRmsDb = new ArrayDeque<>();
        double baselineSum = 0;
        int baselineCount = 0;
        float baselineRmsDb = Float.NaN;

        void reset() {
            lastRmsDb = Float.NaN;
            smoothedRmsDb = Float.NaN;
            avgRmsDb = Float.NaN;
            minRmsDb = Float.NaN;
            maxRmsDb = Float.NaN;
            lastUpdateMs = 0L;
            recentRmsDb.clear();
            baselineSum = 0;
            baselineCount = 0;
            baselineRmsDb = Float.NaN;
        }

        float update(float rmsDb, long nowMs, ListeningState state) {
            lastRmsDb = rmsDb;
            lastUpdateMs = nowMs;

            if (Float.isNaN(avgRmsDb)) {
                avgRmsDb = rmsDb;
            } else {
                avgRmsDb = (RMS_AVG_ALPHA * rmsDb) + ((1 - RMS_AVG_ALPHA) * avgRmsDb);
            }

            if (Float.isNaN(minRmsDb) || rmsDb < minRmsDb) {
                minRmsDb = rmsDb;
            }
            if (Float.isNaN(maxRmsDb) || rmsDb > maxRmsDb) {
                maxRmsDb = rmsDb;
            }

            if (state == ListeningState.IDLE || state == ListeningState.SILENCE_WINDOW) {
                baselineSum += rmsDb;
                baselineCount += 1;
                baselineRmsDb = (float) (baselineSum / baselineCount);
            }

            if (recentRmsDb.size() >= MAX_RECENT_SAMPLES) {
                recentRmsDb.removeFirst();
            }
            recentRmsDb.addLast(rmsDb);

            smoothedRmsDb = computeTailAverage(RMS_SMOOTH_TAIL_SAMPLES);
            return smoothedRmsDb;
        }

        float getSmoothedRmsDb() {
            return smoothedRmsDb;
        }

        private float computeTailAverage(int sampleCount) {
            if (recentRmsDb.isEmpty() || sampleCount <= 0) {
                return lastRmsDb;
            }
            double sum = 0;
            int count = 0;
            Iterator<Float> it = recentRmsDb.descendingIterator();
            while (it.hasNext() && count < sampleCount) {
                sum += it.next();
                count++;
            }
            if (count == 0) return lastRmsDb;
            return (float) (sum / count);
        }

        JSONObject toJson() throws JSONException {
            JSONObject obj = new JSONObject();
            if (!Float.isNaN(lastRmsDb)) obj.put("last_rms_db", lastRmsDb);
            if (!Float.isNaN(smoothedRmsDb)) obj.put("smoothed_rms_db", smoothedRmsDb);
            if (!Float.isNaN(avgRmsDb)) obj.put("avg_rms_db", avgRmsDb);
            if (!Float.isNaN(minRmsDb)) obj.put("min_rms_db", minRmsDb);
            if (!Float.isNaN(maxRmsDb)) obj.put("max_rms_db", maxRmsDb);
            if (!Float.isNaN(baselineRmsDb)) obj.put("baseline_rms_db", baselineRmsDb);
            if (lastUpdateMs > 0) obj.put("last_update_ms", lastUpdateMs);
            if (obj.length() == 0) return null;
            return obj;
        }

        float getBaselineRmsDb() {
            return baselineRmsDb;
        }

        JSONArray recentSamplesToJson() {
            JSONArray arr = new JSONArray();
            for (Float f : recentRmsDb) {
                arr.put(f);
            }
            if (arr.length() == 0) {
                return null;
            }
            return arr;
        }
    }

    private static class AttemptTiming {
        long nativeReceivedMs;
        long nativeStartListeningMs;
        long nativeReadyForSpeechMs;
        long nativeBeginningOfSpeechMs;
        long nativeFirstRmsAboveThresholdMs;
        long nativeRmsSpeechStartMs;
        long nativeRmsSpeechEndMs;
        long nativePostSilenceCommitMs;
        long nativeFailSafeCommitMs;
        long nativeEndOfSpeechMs;
        long nativeResultsMs;
        long nativeErrorMs;
        long nativeNormalizeDoneMs;
        long nativeCallbackSentMs;

        String expectedLetter;
        long attemptId;
    }

    private static class ThresholdConfig {
        final float rmsStartThresholdDb;
        final float rmsEndThresholdDb;
        final float rmsResumeDeltaDb;
        final long postSilenceMs;
        final long minPostSilenceMs;
        final long maxUtteranceMs;
        final float rmsVoiceTriggerDb;
        final int rmsSmoothTailSamples;
        final long silenceHoldMs;

        private ThresholdConfig(float rmsStartThresholdDb,
                                float rmsEndThresholdDb,
                                float rmsResumeDeltaDb,
                                long postSilenceMs,
                                long minPostSilenceMs,
                                long maxUtteranceMs,
                                float rmsVoiceTriggerDb,
                                int rmsSmoothTailSamples,
                                long silenceHoldMs) {
            this.rmsStartThresholdDb = rmsStartThresholdDb;
            this.rmsEndThresholdDb = rmsEndThresholdDb;
            this.rmsResumeDeltaDb = rmsResumeDeltaDb;
            this.postSilenceMs = postSilenceMs;
            this.minPostSilenceMs = minPostSilenceMs;
            this.maxUtteranceMs = maxUtteranceMs;
            this.rmsVoiceTriggerDb = rmsVoiceTriggerDb;
            this.rmsSmoothTailSamples = rmsSmoothTailSamples;
            this.silenceHoldMs = silenceHoldMs;
        }

        static ThresholdConfig defaults() {
            return new ThresholdConfig(
                    RMS_START_THRESHOLD_DB,
                    RMS_END_THRESHOLD_DB,
                    RMS_RESUME_DELTA_DB,
                    POST_SILENCE_MS,
                    MIN_POST_SILENCE_MS,
                    MAX_UTTERANCE_MS,
                    RMS_VOICE_TRIGGER_DB,
                    RMS_SMOOTH_TAIL_SAMPLES,
                    SILENCE_HOLD_MS
            );
        }

        JSONObject toJson(float baselineRmsDb,
                          float adaptiveEndThresholdDb,
                          long postSilenceDelayMs,
                          boolean noPartialAdjustActive,
                          long noPartialPostSilenceBoostMs) throws JSONException {
            JSONObject thresholds = new JSONObject();
            thresholds.put("rms_voice_trigger_db", rmsVoiceTriggerDb);
            if (Float.isInfinite(rmsStartThresholdDb)) {
                thresholds.put("rms_start_threshold_db", "-Infinity");
            } else {
                thresholds.put("rms_start_threshold_db", rmsStartThresholdDb);
            }
            thresholds.put("rms_end_threshold_db", rmsEndThresholdDb);
            thresholds.put("rms_resume_delta_db", rmsResumeDeltaDb);
            thresholds.put("post_silence_ms", postSilenceMs);
            thresholds.put("min_post_silence_ms", minPostSilenceMs);
            thresholds.put("max_utterance_ms", maxUtteranceMs);
            thresholds.put("rms_smooth_tail_samples", rmsSmoothTailSamples);
            thresholds.put("silence_hold_ms", silenceHoldMs);
            thresholds.put("adaptive_end_threshold_db", adaptiveEndThresholdDb);
            thresholds.put("post_silence_ms_effective", postSilenceDelayMs);
            thresholds.put("no_partial_adjust_active", noPartialAdjustActive);
            thresholds.put("no_partial_post_silence_boost_ms", Math.max(0, noPartialPostSilenceBoostMs));
            if (!Float.isNaN(baselineRmsDb)) {
                thresholds.put("baseline_rms_db", baselineRmsDb);
            }
            return thresholds;
        }
    }

    @Override
    public void initialize(CordovaInterface cordova, CordovaWebView webView) {
        super.initialize(cordova, webView);
        handler = new Handler(Looper.getMainLooper());
        audioManager = (AudioManager) cordova.getActivity().getSystemService(Context.AUDIO_SERVICE);
        Log.d(TAG, "LimeTunaSpeech initialize");
    }

    private boolean hasAudioPermission() {
        return PermissionHelper.hasPermission(this, Manifest.permission.RECORD_AUDIO);
    }

    private void requestAudioPermission() {
        PermissionHelper.requestPermission(
                this,
                REQ_RECORD_AUDIO,
                Manifest.permission.RECORD_AUDIO
        );
    }

    // Must be called ONLY on main thread
    private void createRecognizerIfNeededOnMainThread() {
        if (speechRecognizer == null) {
            Log.d(TAG, "Creating SpeechRecognizer");
            if (!SpeechRecognizer.isRecognitionAvailable(
                    cordova.getActivity().getApplicationContext())) {
                Log.e(TAG, "Speech recognition NOT available on this device");
                return;
            }

            if (recognizerServiceOverride != null) {
                speechRecognizer = SpeechRecognizer.createSpeechRecognizer(
                        cordova.getActivity().getApplicationContext(),
                        recognizerServiceOverride
                );
            } else {
                speechRecognizer = SpeechRecognizer.createSpeechRecognizer(
                        cordova.getActivity().getApplicationContext()
                );
            }
            speechRecognizer.setRecognitionListener(this);
        }
    }

    private void rebuildRecognizerOnMainThread(String reason) {
        Runnable rebuild = new Runnable() {
            @Override
            public void run() {
                Log.w(TAG, "Rebuilding SpeechRecognizer reason=" + reason);
                destroyRecognizer();
                createRecognizerIfNeededOnMainThread();
                recognizerResetPending = false;
            }
        };

        if (Looper.myLooper() == Looper.getMainLooper()) {
            rebuild.run();
        } else if (handler != null) {
            handler.post(rebuild);
        }
    }

    private void requestRecognizerReset(String reason) {
        requestRecognizerReset(reason, true);
    }

    private void requestRecognizerReset(String reason, boolean notifyCurrentAttempt) {
        if (recognizerResetPending) {
            return;
        }
        recognizerResetPending = true;
        if (handler != null) {
            handler.post(new Runnable() {
                @Override
                public void run() {
                    if (isListening && currentCallback != null && notifyCurrentAttempt) {
                        sendErrorToCallback("ENGINE_RESET", "Recognizer reset: " + reason, currentTiming);
                    }
                    rebuildRecognizerOnMainThread(reason);
                }
            });
        } else {
            if (isListening && currentCallback != null && notifyCurrentAttempt) {
                sendErrorToCallback("ENGINE_RESET", "Recognizer reset: " + reason, currentTiming);
            }
            rebuildRecognizerOnMainThread(reason);
        }
    }

    // ---- Global beep muting --------------------------------------------------

    private void applyBeepsMuted(boolean mute) {
        if (audioManager == null) return;

        if (mute) {
            if (volumesMuted) return;
            try {
                originalSystemVolume = audioManager.getStreamVolume(AudioManager.STREAM_SYSTEM);
                originalNotificationVolume = audioManager.getStreamVolume(AudioManager.STREAM_NOTIFICATION);
                originalRingVolume = audioManager.getStreamVolume(AudioManager.STREAM_RING);

                audioManager.setStreamVolume(AudioManager.STREAM_SYSTEM, 0, 0);
                audioManager.setStreamVolume(AudioManager.STREAM_NOTIFICATION, 0, 0);
                audioManager.setStreamVolume(AudioManager.STREAM_RING, 0, 0);

                volumesMuted = true;
                Log.d(TAG, "System/notification/ring volumes muted");
            } catch (Exception e) {
                Log.w(TAG, "Failed to mute system/notification/ring", e);
            }
        } else {
            if (!volumesMuted) return;
            try {
                if (originalSystemVolume >= 0) {
                    audioManager.setStreamVolume(AudioManager.STREAM_SYSTEM, originalSystemVolume, 0);
                }
                if (originalNotificationVolume >= 0) {
                    audioManager.setStreamVolume(AudioManager.STREAM_NOTIFICATION, originalNotificationVolume, 0);
                }
                if (originalRingVolume >= 0) {
                    audioManager.setStreamVolume(AudioManager.STREAM_RING, originalRingVolume, 0);
                }
                Log.d(TAG, "System/notification/ring volumes restored");
            } catch (Exception e) {
                Log.w(TAG, "Failed to restore system/notification/ring", e);
            } finally {
                volumesMuted = false;
                originalSystemVolume = -1;
                originalNotificationVolume = -1;
                originalRingVolume = -1;
            }
        }
    }

    // --------------------------------------------------------------------------

    @Override
    public boolean execute(String action, JSONArray args, CallbackContext callbackContext) throws JSONException {
        Log.d(TAG, "execute: " + action);

        switch (action) {
            case "init":
                return handleInit(args, callbackContext);
            case "startLetter":
                return handleStartLetter(args, callbackContext);
            case "stop":
                return handleStop(callbackContext);
            case "setBeepsMuted":
                return handleSetBeepsMuted(args, callbackContext);
            case "setKeepScreenOn":
                return handleSetKeepScreenOn(args, callbackContext);
            case "resetRecognizer":
                return handleResetRecognizer(callbackContext);
            default:
                return false;
        }
    }

    private boolean handleInit(final JSONArray args, final CallbackContext callbackContext) {
        try {
            if (args != null && args.length() > 0 && !args.isNull(0)) {
                JSONObject opts = args.getJSONObject(0);
                if (opts.has("language")) {
                    language = opts.getString("language");
                }
                updateThresholdConfigFromOptions(opts);
                updateRecognizerServiceFromOptions(opts);
            }

            if (!hasAudioPermission()) {
                Log.d(TAG, "No RECORD_AUDIO permission, requesting");
                pendingInitCallback = callbackContext;
                requestAudioPermission();
                return true;
            }

            cordova.getActivity().runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (!SpeechRecognizer.isRecognitionAvailable(
                            cordova.getActivity().getApplicationContext())) {
                        Log.e(TAG, "Speech recognition NOT available on this device");
                        callbackContext.error(buildErrorJson(
                                "ENGINE_UNAVAILABLE",
                                "Speech recognition not available"
                        ));
                        return;
                    }

                    createRecognizerIfNeededOnMainThread();
                    if (speechRecognizer == null) {
                        callbackContext.error(buildErrorJson(
                                "ENGINE_CREATE_FAILED",
                                "Failed to create SpeechRecognizer"
                        ));
                        return;
                    }

                    callbackContext.success();
                }
            });

            return true;

        } catch (JSONException e) {
            Log.e(TAG, "Error parsing init options", e);
            callbackContext.error("INIT_OPTIONS_ERROR");
            return true;
        }
    }

    private boolean handleStartLetter(final JSONArray args, final CallbackContext callbackContext) {
        if (!hasAudioPermission()) {
            callbackContext.error(buildErrorJson("PERMISSION_DENIED", "Microphone permission not granted"));
            return true;
        }

        cordova.getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                Log.d(TAG, "handleStartLetter on UI thread");

                if (!SpeechRecognizer.isRecognitionAvailable(
                        cordova.getActivity().getApplicationContext())) {
                    Log.e(TAG, "Speech recognition NOT available in startLetter");
                    callbackContext.error(buildErrorJson(
                            "ENGINE_UNAVAILABLE",
                            "Speech recognition not available"
                    ));
                    return;
                }

                if (stopIssued || recognizerResetPending || speechRecognizer == null) {
                    Log.w(TAG, "Preflight rebuild (stopIssued=" + stopIssued + ", pendingReset=" + recognizerResetPending + ")");
                    rebuildRecognizerOnMainThread("start_preflight");
                }

                createRecognizerIfNeededOnMainThread();
                if (speechRecognizer == null) {
                    callbackContext.error(buildErrorJson(
                            "ENGINE_CREATE_FAILED",
                            "Failed to create SpeechRecognizer"
                    ));
                    return;
                }

                if (isListening) {
                    Log.w(TAG, "Already listening");
                    callbackContext.error(buildErrorJson("ALREADY_LISTENING", "Already listening"));
                    return;
                }

                ThresholdConfig thresholds = thresholdConfig.get();

                currentCallback = callbackContext;
                isListening = true;
                stopIssued = false;
                listeningState = ListeningState.IDLE;
                cancelSilenceTimer(true);
                rmsStats.reset();
                lastRmsDispatchMs = 0L;
                lastPartialResults = null;
                partialResultsSeen = false;
                awaitingPartialAfterBos = false;
                consecutiveZeroRmsWindows = 0;
                belowEndThresholdSinceMs = 0L;
                sessionPeakRmsDb = Float.NEGATIVE_INFINITY;
                adaptiveEndThresholdDb = computeEndThresholdDb(thresholds);
                lastComputedPostSilenceDelayMs = thresholds.postSilenceMs;
                lastComputedEndThresholdDb = adaptiveEndThresholdDb;

                AttemptTiming timing = new AttemptTiming();
                timing.nativeReceivedMs = SystemClock.elapsedRealtime();
                timing.attemptId = ++attemptCounter;
                timing.expectedLetter = (args != null && args.length() > 0) ? args.optString(0, null) : null;
                currentTiming = timing;
                Log.d(TAG, "LimeTunaSpeech stage=received t=" + timing.nativeReceivedMs + " expected=" + timing.expectedLetter);

                Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                        RecognizerIntent.LANGUAGE_MODEL_WEB_SEARCH);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, language);
                intent.putExtra(RecognizerIntent.EXTRA_ONLY_RETURN_LANGUAGE_PREFERENCE, language);
                intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE,
                        cordova.getActivity().getPackageName());
                intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 10);
                intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
                intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, false);
                intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, thresholds.postSilenceMs);
                intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, Math.max(500L, thresholds.postSilenceMs / 2));
                intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, 500L);

                try {
                    if (currentTiming != null) {
                        currentTiming.nativeStartListeningMs = SystemClock.elapsedRealtime();
                        Log.d(TAG, "LimeTunaSpeech stage=startListening t=" + currentTiming.nativeStartListeningMs);
                    }
                    Log.d(TAG, "Calling startListening");
                    sendMilestoneEvent("startListening", null);
                    speechRecognizer.startListening(intent);
                } catch (Exception e) {
                    Log.e(TAG, "startListening failed", e);
                    sendErrorToCallback("START_FAILED", "Failed to start listening", currentTiming);
                }
            }
        });

        return true;
    }

    private boolean handleStop(final CallbackContext callbackContext) {
        cordova.getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                stopListeningInternal(true);
                callbackContext.success();
            }
        });
        return true;
    }

    private boolean handleResetRecognizer(final CallbackContext callbackContext) {
        cordova.getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                rebuildRecognizerOnMainThread("js_reset_request");
                if (speechRecognizer != null) {
                    callbackContext.success();
                } else {
                    callbackContext.error(buildErrorJson(
                            "ENGINE_CREATE_FAILED",
                            "Failed to reset SpeechRecognizer"
                    ));
                }
            }
        });
        return true;
    }

    private boolean handleSetBeepsMuted(final JSONArray args, final CallbackContext callbackContext) {
        final boolean mute = (args != null && args.length() > 0) && args.optBoolean(0, true);

        cordova.getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                applyBeepsMuted(mute);
                callbackContext.success();
            }
        });

        return true;
    }

    private boolean handleSetKeepScreenOn(final JSONArray args, final CallbackContext callbackContext) {
        final boolean keepOn = (args != null && args.length() > 0) && args.optBoolean(0, true);

        cordova.getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                Activity activity = cordova.getActivity();
                if (activity != null) {
                    Window window = activity.getWindow();
                    if (window != null) {
                        if (keepOn) {
                            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                            Log.d(TAG, "FLAG_KEEP_SCREEN_ON enabled");
                        } else {
                            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                            Log.d(TAG, "FLAG_KEEP_SCREEN_ON cleared");
                        }
                    }
                }
                callbackContext.success();
            }
        });

        return true;
    }

    private String buildErrorJson(String code, String message) {
        try {
            JSONObject err = new JSONObject();
            err.put("code", code);
            err.put("message", message);
            return err.toString();
        } catch (JSONException e) {
            return code + ":" + message;
        }
    }

    private void sendErrorToCallback(String code, String message, AttemptTiming timing) {
        if (currentCallback != null) {
            try {
                if (timing != null) {
                    timing.nativeErrorMs = SystemClock.elapsedRealtime();
                    timing.nativeCallbackSentMs = timing.nativeErrorMs;
                }
                JSONObject obj = buildErrorJsonObject(code, message, timing);
                currentCallback.error(obj.toString());
            } catch (JSONException e) {
                currentCallback.error(buildErrorJson(code, message));
            }
            currentCallback = null;
        }
        lastPartialResults = null;
        isListening = false;
        resetListeningState();
        currentTiming = null;
    }

    private void sendSuccessToCallback(String text, Float confidence,
                                       ArrayList<String> all, float[] confs,
                                       AttemptTiming timing) {

        if (currentCallback != null) {
            try {
                JSONObject json = new JSONObject();
                json.put("text", text != null ? text : "");

                if (confidence != null) {
                    json.put("confidence", confidence);
                } else {
                    json.put("confidence", JSONObject.NULL);
                }

                if (all != null) {
                    json.put("allResults", new JSONArray(all));
                }
                if (confs != null) {
                    JSONArray confArr = new JSONArray();
                    for (float c : confs) {
                        confArr.put(c);
                    }
                    json.put("allConfidences", confArr);
                }

                if (timing != null) {
                    json.put("attempt_id", timing.attemptId);
                    if (timing.expectedLetter != null) {
                        json.put("expected_letter", timing.expectedLetter);
                    }
                    timing.nativeCallbackSentMs = SystemClock.elapsedRealtime();
                    json.put("timing", buildTimingJson(timing));
                }

                currentCallback.success(json.toString());
            } catch (JSONException e) {
                Log.e(TAG, "Error building success JSON", e);
                currentCallback.success(text != null ? text : "");
            }

            currentCallback = null;
        }

        isListening = false;
        resetListeningState();
        currentTiming = null;
    }

    private void stopListeningInternal(boolean cancel) {
        cancelSilenceTimer(false);

        if (!stopIssued && speechRecognizer != null && isListening) {
            sendMilestoneEvent("stop_listening", null);
            try {
                if (cancel) {
                    speechRecognizer.cancel();
                } else {
                    speechRecognizer.stopListening();
                }
                stopIssued = true;
            } catch (Exception e) {
                Log.w(TAG, "Error stopping recognizer", e);
            }
        }

        isListening = false;
        listeningState = ListeningState.IDLE;
    }

    // RecognitionListener ------------------------------------------------------

    @Override
    public void onReadyForSpeech(Bundle params) {
        Log.d(TAG, "onReadyForSpeech");
        if (currentTiming != null) {
            currentTiming.nativeReadyForSpeechMs = SystemClock.elapsedRealtime();
            Log.d(TAG, "LimeTunaSpeech stage=ready t=" + currentTiming.nativeReadyForSpeechMs);
            sendMilestoneEvent("onReadyForSpeech", null);
        }
    }

    @Override
    public void onBeginningOfSpeech() {
        Log.d(TAG, "onBeginningOfSpeech");
        listeningState = ListeningState.SPEECH;
        awaitingPartialAfterBos = true;
        if (currentTiming != null) {
            currentTiming.nativeBeginningOfSpeechMs = SystemClock.elapsedRealtime();
            ensureRmsSpeechStart(currentTiming.nativeBeginningOfSpeechMs);
            Log.d(TAG, "LimeTunaSpeech stage=begin_speech t=" + currentTiming.nativeBeginningOfSpeechMs);
            sendMilestoneEvent("onBeginningOfSpeech", null);
        }
    }

    @Override
    public void onRmsChanged(float rmsdB) {
        Log.v(TAG, "onRmsChanged: " + rmsdB);
        ThresholdConfig thresholds = thresholdConfig.get();
        long now = SystemClock.elapsedRealtime();
        float smoothedRmsDb = rmsStats.update(rmsdB, now, listeningState);
        float detectionRmsDb = Float.isNaN(smoothedRmsDb) ? rmsdB : smoothedRmsDb;

        sessionPeakRmsDb = Math.max(sessionPeakRmsDb, detectionRmsDb);
        float endThresholdFloor = computeEndThresholdDb(thresholds);
        if (shouldDeferCommitForMissingPartials()) {
            endThresholdFloor = Math.max(thresholds.rmsVoiceTriggerDb, endThresholdFloor - NO_PARTIAL_END_THRESHOLD_DELTA_DB);
        }
        if (!Float.isInfinite(sessionPeakRmsDb)) {
            float candidate = detectionRmsDb * 0.8f; // 20% below peak
            float floored = Math.max(candidate, endThresholdFloor);
            adaptiveEndThresholdDb = Math.min(thresholds.rmsEndThresholdDb, floored);
        } else {
            adaptiveEndThresholdDb = endThresholdFloor;
        }
        lastComputedEndThresholdDb = adaptiveEndThresholdDb;
        if (currentTiming != null && currentTiming.nativeFirstRmsAboveThresholdMs == 0 && detectionRmsDb > thresholds.rmsVoiceTriggerDb) {
            currentTiming.nativeFirstRmsAboveThresholdMs = SystemClock.elapsedRealtime();
            Log.d(TAG, "LimeTunaSpeech stage=rms_threshold t=" + currentTiming.nativeFirstRmsAboveThresholdMs + " rmsdB=" + detectionRmsDb);
        }

        if (!isListening) {
            return;
        }

        switch (listeningState) {
            case IDLE:
                listeningState = ListeningState.SPEECH;
                ensureRmsSpeechStart(now);
                cancelSilenceTimer(true);
                belowEndThresholdSinceMs = 0L;
                break;
            case SPEECH:
                if (detectionRmsDb < adaptiveEndThresholdDb) {
                    if (belowEndThresholdSinceMs == 0L) {
                        belowEndThresholdSinceMs = now;
                    }
                    if ((now - belowEndThresholdSinceMs) >= thresholds.silenceHoldMs) {
                        beginSilenceWindow(now);
                    }
                } else {
                    belowEndThresholdSinceMs = 0L;
                }
                break;
            case SILENCE_WINDOW: {
                if (detectionRmsDb >= adaptiveEndThresholdDb + thresholds.rmsResumeDeltaDb) {
                    cancelSilenceTimer(true);
                    listeningState = ListeningState.SPEECH;
                    ensureRmsSpeechStart(now);
                    belowEndThresholdSinceMs = 0L;
                }
                break;
            }
            case COMMIT:
                // Waiting for commit; ignore further RMS.
                break;
        }

        if (isListening) {
            sendRmsUpdateToCallback(rmsdB, detectionRmsDb, now);
        }

        if (rmsdB == 0f) {
            consecutiveZeroRmsWindows++;
            if (consecutiveZeroRmsWindows >= ZERO_RMS_STREAK_THRESHOLD && !recognizerResetPending) {
                Log.w(TAG, "Zero-RMS streak detected; scheduling recognizer reset");
                requestRecognizerReset("zero_rms_streak");
            }
        } else {
            consecutiveZeroRmsWindows = 0;
        }
    }

    @Override
    public void onBufferReceived(byte[] buffer) {
        // not used
    }

    @Override
    public void onEndOfSpeech() {
        Log.d(TAG, "onEndOfSpeech");
        long now = SystemClock.elapsedRealtime();
        beginSilenceWindow(now);
        if (currentTiming != null) {
            currentTiming.nativeEndOfSpeechMs = now;
            if (currentTiming.nativeRmsSpeechEndMs == 0) {
                currentTiming.nativeRmsSpeechEndMs = currentTiming.nativeEndOfSpeechMs;
            }
            Log.d(TAG, "LimeTunaSpeech stage=end_speech t=" + currentTiming.nativeEndOfSpeechMs);
        }
    }

    @Override
    public void onError(int error) {
        Log.d(TAG, "onError: " + error);

        if (!isListening && currentCallback == null) {
            return;
        }

        if (currentTiming != null) {
            currentTiming.nativeErrorMs = SystemClock.elapsedRealtime();
            Log.d(TAG, "LimeTunaSpeech stage=error t=" + currentTiming.nativeErrorMs + " code=" + error);
            JSONObject extras = new JSONObject();
            try {
                extras.put("error_code", error);
                extras.put("error_label", mapErrorLabel(error));
            } catch (JSONException e) {
                Log.w(TAG, "Failed to build error milestone extras", e);
            }
            sendMilestoneEvent("onError", extras);
        }

        if (error == SpeechRecognizer.ERROR_NO_MATCH && lastPartialResults != null && !lastPartialResults.isEmpty()) {
            Log.i(TAG, "NO_MATCH with partials; emitting partial fallback result");
            sendSuccessToCallback(lastPartialResults.get(0), null, new ArrayList<>(lastPartialResults), null, currentTiming);
            return;
        }

        String code;
        switch (error) {
            case SpeechRecognizer.ERROR_NO_MATCH:
                code = "NO_MATCH";
                break;
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                code = "SPEECH_TIMEOUT";
                break;
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                code = "INSUFFICIENT_PERMISSIONS";
                break;
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
            case SpeechRecognizer.ERROR_CLIENT:
                code = "ENGINE_RESTART_REQUIRED";
                requestRecognizerReset(mapErrorLabel(error).toLowerCase(), false);
                break;
            default:
                code = "ERROR_" + error;
                break;
        }

        sendErrorToCallback(code, "Speech recognition error", currentTiming);
    }

    @Override
    public void onResults(Bundle results) {
        Log.d(TAG, "onResults");

        if (!isListening && currentCallback == null) {
            return;
        }

        if (currentTiming != null) {
            currentTiming.nativeResultsMs = SystemClock.elapsedRealtime();
            Log.d(TAG, "LimeTunaSpeech stage=results t=" + currentTiming.nativeResultsMs);
        }

        ArrayList<String> matches =
                results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        float[] confidences =
                results.getFloatArray(SpeechRecognizer.CONFIDENCE_SCORES);

        Log.d(TAG, "matches=" + matches + " confidences=" + (confidences == null ? "null" : confidences.length));

        if ((matches == null || matches.isEmpty()) && lastPartialResults != null && !lastPartialResults.isEmpty()) {
            Log.i(TAG, "Falling back to partial results: " + lastPartialResults);
            matches = new ArrayList<>(lastPartialResults);
            confidences = null;
            sendMilestoneEvent("partial_fallback", null);
        }

        if (matches == null || matches.isEmpty()) {
            sendErrorToCallback("NO_MATCH", "No recognition result", currentTiming);
            return;
        }

        String bestText = matches.get(0);
        Float bestConf = null;

        if (confidences != null && confidences.length == matches.size()) {
            int bestIndex = 0;
            float bestScore = confidences[0];
            for (int i = 1; i < confidences.length; i++) {
                if (confidences[i] > bestScore) {
                    bestScore = confidences[i];
                    bestIndex = i;
                }
            }
            bestText = matches.get(bestIndex);
            bestConf = bestScore;
        }

        if (currentTiming != null) {
            currentTiming.nativeNormalizeDoneMs = SystemClock.elapsedRealtime();
        }

        sendSuccessToCallback(bestText, bestConf, matches, confidences, currentTiming);
    }

    @Override
    public void onPartialResults(Bundle partialResults) {
        if (!isListening && currentCallback == null) {
            return;
        }

        ArrayList<String> partial =
                partialResults.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (partial != null && !partial.isEmpty()) {
            lastPartialResults = new ArrayList<>(partial);
            partialResultsSeen = true;
            awaitingPartialAfterBos = false;
            JSONObject extras = new JSONObject();
            try {
                extras.put("partial_size", partial.size());
                extras.put("partial_top", partial.get(0));
            } catch (JSONException e) {
                Log.w(TAG, "Failed to build partial extras", e);
            }
            sendMilestoneEvent("partial_results", extras);
        }
    }

    @Override
    public void onEvent(int eventType, Bundle params) {
        // not used
    }

    // Permission result --------------------------------------------------------

    @Override
    public void onRequestPermissionResult(int requestCode, String[] permissions,
                                          int[] grantResults) throws JSONException {

        if (requestCode != REQ_RECORD_AUDIO) {
            return;
        }

        boolean granted = true;
        if (grantResults != null && grantResults.length > 0) {
            for (int r : grantResults) {
                if (r == PackageManager.PERMISSION_DENIED) {
                    granted = false;
                    break;
                }
            }
        } else {
            granted = false;
        }

        if (pendingInitCallback != null) {
            if (granted) {
                cordova.getActivity().runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (!SpeechRecognizer.isRecognitionAvailable(
                                cordova.getActivity().getApplicationContext())) {
                            pendingInitCallback.error(buildErrorJson(
                                    "ENGINE_UNAVAILABLE",
                                    "Speech recognition not available"
                            ));
                        } else {
                            createRecognizerIfNeededOnMainThread();
                            if (speechRecognizer == null) {
                                pendingInitCallback.error(buildErrorJson(
                                        "ENGINE_CREATE_FAILED",
                                        "Failed to create SpeechRecognizer"
                                ));
                            } else {
                                pendingInitCallback.success();
                            }
                        }
                    }
                });
            } else {
                pendingInitCallback.error(buildErrorJson("PERMISSION_DENIED", "Microphone permission denied"));
            }
            pendingInitCallback = null;
        }
    }

    // Cleanup ------------------------------------------------------------------

    @Override
    public void onReset() {
        super.onReset();
        destroyRecognizer();
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        destroyRecognizer();
    }

    private void destroyRecognizer() {
        if (speechRecognizer != null) {
            try {
                speechRecognizer.destroy();
            } catch (Exception e) {
                Log.w(TAG, "Error destroying recognizer", e);
            }
            speechRecognizer = null;
        }
        currentCallback = null;
        isListening = false;
        resetListeningState();
        currentTiming = null;

        // Safety: restore volumes if we die while muted
        applyBeepsMuted(false);
    }

    private JSONObject buildErrorJsonObject(String code, String message, AttemptTiming timing) throws JSONException {
        JSONObject err = new JSONObject();
        err.put("code", code);
        err.put("message", message);
        if (timing != null) {
            err.put("attempt_id", timing.attemptId);
            if (timing.expectedLetter != null) {
                err.put("expected_letter", timing.expectedLetter);
            }
            err.put("timing", buildTimingJson(timing));
        }
        return err;
    }

    private JSONObject buildTimingJson(AttemptTiming timing) throws JSONException {
        JSONObject timingJson = new JSONObject();
        JSONObject raw = new JSONObject();

        putIfPositive(raw, "native_received_ms", timing.nativeReceivedMs);
        putIfPositive(raw, "native_startListening_ms", timing.nativeStartListeningMs);
        putIfPositive(raw, "native_readyForSpeech_ms", timing.nativeReadyForSpeechMs);
        putIfPositive(raw, "native_beginningOfSpeech_ms", timing.nativeBeginningOfSpeechMs);
        putIfPositive(raw, "native_firstRmsAboveThreshold_ms", timing.nativeFirstRmsAboveThresholdMs);
        putIfPositive(raw, "native_rmsSpeechStart_ms", timing.nativeRmsSpeechStartMs);
        putIfPositive(raw, "native_rmsSpeechEnd_ms", timing.nativeRmsSpeechEndMs);
        putIfPositive(raw, "native_postSilenceCommit_ms", timing.nativePostSilenceCommitMs);
        putIfPositive(raw, "native_failSafeCommit_ms", timing.nativeFailSafeCommitMs);
        putIfPositive(raw, "native_endOfSpeech_ms", timing.nativeEndOfSpeechMs);
        putIfPositive(raw, "native_results_ms", timing.nativeResultsMs);
        putIfPositive(raw, "native_error_ms", timing.nativeErrorMs);
        putIfPositive(raw, "native_normalize_done_ms", timing.nativeNormalizeDoneMs);
        putIfPositive(raw, "native_callback_sent_ms", timing.nativeCallbackSentMs);

        if (timing.expectedLetter != null) {
            raw.put("expected_letter", timing.expectedLetter);
        }

        JSONObject rmsJson = rmsStats.toJson();
        if (rmsJson != null) {
            timingJson.put("rms_debug", rmsJson);
        }

        JSONObject durations = new JSONObject();
        putDuration(durations, "d_queue_native_ms", timing.nativeStartListeningMs, timing.nativeReceivedMs);
        putDuration(durations, "d_engine_ready_ms", timing.nativeReadyForSpeechMs, timing.nativeStartListeningMs);

        long speechAnchorStart = timing.nativeReadyForSpeechMs > 0 ? timing.nativeReadyForSpeechMs : timing.nativeStartListeningMs;
        long speechAnchorEnd = timing.nativeRmsSpeechStartMs > 0
                ? timing.nativeRmsSpeechStartMs
                : (timing.nativeBeginningOfSpeechMs > 0 ? timing.nativeBeginningOfSpeechMs : timing.nativeFirstRmsAboveThresholdMs);
        putDuration(durations, "d_user_speech_to_engine_ms", speechAnchorEnd, speechAnchorStart);

        long speechAnchorStop = timing.nativeRmsSpeechEndMs > 0 ? timing.nativeRmsSpeechEndMs : timing.nativeEndOfSpeechMs;
        putDuration(durations, "d_engine_processing_ms", timing.nativeResultsMs, speechAnchorStop);
        putDuration(durations, "d_normalize_ms", timing.nativeNormalizeDoneMs, timing.nativeResultsMs);

        ThresholdConfig thresholds = thresholdConfig.get();
        if (thresholds == null) {
            thresholds = ThresholdConfig.defaults();
        }
        long postSilenceBoostMs = lastComputedPostSilenceDelayMs - thresholds.postSilenceMs;
        JSONObject thresholdsJson = thresholds.toJson(
                rmsStats.getBaselineRmsDb(),
                lastComputedEndThresholdDb,
                lastComputedPostSilenceDelayMs,
                shouldDeferCommitForMissingPartials(),
                postSilenceBoostMs);

        timingJson.put("native_raw", raw);
        timingJson.put("native_durations", durations);
        timingJson.put("native_thresholds", thresholdsJson);

        return timingJson;
    }

    private void putIfPositive(JSONObject obj, String key, long value) throws JSONException {
        if (value > 0) {
            obj.put(key, value);
        }
    }

    private void putDuration(JSONObject obj, String key, long end, long start) throws JSONException {
        if (end > 0 && start > 0 && end >= start) {
            obj.put(key, end - start);
        }
    }

    private void beginSilenceWindow(long now) {
        if (listeningState == ListeningState.SILENCE_WINDOW || listeningState == ListeningState.COMMIT) {
            return;
        }

        listeningState = ListeningState.SILENCE_WINDOW;
        belowEndThresholdSinceMs = 0L;
        if (currentTiming != null && currentTiming.nativeRmsSpeechEndMs == 0) {
            currentTiming.nativeRmsSpeechEndMs = now;
        }

        cancelSpeechFailSafe();
        sendMilestoneEvent("enter_silence_window", null);

        if (handler != null) {
            ThresholdConfig thresholds = thresholdConfig.get();
            long postSilenceDelayMs = computePostSilenceDelay(now, thresholds);
            if (shouldDeferCommitForMissingPartials()) {
                postSilenceDelayMs = Math.min(thresholds.maxUtteranceMs, postSilenceDelayMs + NO_PARTIAL_POST_SILENCE_BOOST_MS);
            }
            lastComputedPostSilenceDelayMs = postSilenceDelayMs;
            silenceTimeoutRunnable = new Runnable() {
                @Override
                public void run() {
                    if (stopIssued) {
                        return;
                    }
                    listeningState = ListeningState.COMMIT;
                    cancelSpeechFailSafe();
                    if (currentTiming != null && currentTiming.nativePostSilenceCommitMs == 0) {
                        currentTiming.nativePostSilenceCommitMs = SystemClock.elapsedRealtime();
                    }
                    sendMilestoneEvent("post_silence_commit", buildCommitExtras("post_silence_commit", true));
                    stopListeningInternal(false);
                }
            };
            handler.postDelayed(silenceTimeoutRunnable, postSilenceDelayMs);
        }
    }

    private long computePostSilenceDelay(long now, ThresholdConfig thresholds) {
        long speechStart = 0L;
        if (currentTiming != null) {
            speechStart = currentTiming.nativeRmsSpeechStartMs > 0
                    ? currentTiming.nativeRmsSpeechStartMs
                    : currentTiming.nativeBeginningOfSpeechMs;
        }
        long speechDuration = speechStart > 0 ? Math.max(0, now - speechStart) : 0L;
        long adaptive = thresholds.postSilenceMs;
        if (speechDuration > 0) {
            long reduction = speechDuration / 3;
            adaptive = Math.max(thresholds.minPostSilenceMs, thresholds.postSilenceMs - reduction);
        } else {
            adaptive = Math.max(thresholds.minPostSilenceMs, thresholds.postSilenceMs);
        }
        return adaptive;
    }

    private void cancelSilenceTimer(boolean clearEndTime) {
        if (handler != null && silenceTimeoutRunnable != null) {
            handler.removeCallbacks(silenceTimeoutRunnable);
        }
        silenceTimeoutRunnable = null;
        belowEndThresholdSinceMs = 0L;
        if (clearEndTime && currentTiming != null && listeningState == ListeningState.SILENCE_WINDOW) {
            currentTiming.nativeRmsSpeechEndMs = 0;
        }
    }

    private void ensureRmsSpeechStart(long startMs) {
        if (currentTiming != null && currentTiming.nativeRmsSpeechStartMs == 0) {
            currentTiming.nativeRmsSpeechStartMs = startMs;
            scheduleSpeechFailSafe(startMs);
        }
    }

    private void scheduleSpeechFailSafe(long startMs) {
        cancelSpeechFailSafe();
        if (handler != null) {
            speechFailSafeRunnable = new Runnable() {
                @Override
                public void run() {
                    if (stopIssued || listeningState == ListeningState.COMMIT) {
                        return;
                    }
                    listeningState = ListeningState.COMMIT;
                    long now = SystemClock.elapsedRealtime();
                    if (currentTiming != null && currentTiming.nativeRmsSpeechEndMs == 0) {
                        currentTiming.nativeRmsSpeechEndMs = now;
                    }
                    if (currentTiming != null && currentTiming.nativeFailSafeCommitMs == 0) {
                        currentTiming.nativeFailSafeCommitMs = now;
                    }
                    sendMilestoneEvent("failsafe_commit", buildCommitExtras("max_utterance_commit", false));
                    stopListeningInternal(false);
                }
            };
            ThresholdConfig thresholds = thresholdConfig.get();
            handler.postDelayed(speechFailSafeRunnable, thresholds.maxUtteranceMs);
        }
    }

    private void cancelSpeechFailSafe() {
        if (handler != null && speechFailSafeRunnable != null) {
            handler.removeCallbacks(speechFailSafeRunnable);
        }
        speechFailSafeRunnable = null;
    }

    private float computeEndThresholdDb(ThresholdConfig thresholds) {
        if (thresholds == null) {
            return RMS_END_THRESHOLD_DB;
        }
        float base = thresholds.rmsEndThresholdDb;
        float baseline = rmsStats.getBaselineRmsDb();
        if (!Float.isNaN(baseline)) {
            float deltaFromBaseline = Math.max(END_BASELINE_DELTA_DB_MIN,
                    Math.abs(baseline) * END_BASELINE_DELTA_PERCENT);
            base = baseline + deltaFromBaseline;
        }
        return base;
    }

    private boolean shouldDeferCommitForMissingPartials() {
        return awaitingPartialAfterBos && !partialResultsSeen &&
                (lastPartialResults == null || lastPartialResults.isEmpty());
    }

    private void resetListeningState() {
        cancelSilenceTimer(false);
        cancelSpeechFailSafe();
        listeningState = ListeningState.IDLE;
        stopIssued = false;
        consecutiveZeroRmsWindows = 0;
        belowEndThresholdSinceMs = 0L;
        awaitingPartialAfterBos = false;
        partialResultsSeen = false;
        lastComputedPostSilenceDelayMs = POST_SILENCE_MS;
        lastComputedEndThresholdDb = RMS_END_THRESHOLD_DB;
    }

    private void sendRmsUpdateToCallback(float rmsdB, float smoothedRmsDb, long now) {
        if (currentCallback == null) {
            return;
        }

        if (lastRmsDispatchMs > 0 && (now - lastRmsDispatchMs) < RMS_DISPATCH_INTERVAL_MS) {
            return;
        }
        lastRmsDispatchMs = now;

        try {
            JSONObject obj = new JSONObject();
            obj.put("type", "rms");
            obj.put("rms_db", rmsStats.lastRmsDb);
            if (!Float.isNaN(smoothedRmsDb)) obj.put("smoothed_rms_db", smoothedRmsDb);
            if (!Float.isNaN(rmsStats.avgRmsDb)) obj.put("avg_rms_db", rmsStats.avgRmsDb);
            if (!Float.isNaN(rmsStats.minRmsDb)) obj.put("min_rms_db", rmsStats.minRmsDb);
            if (!Float.isNaN(rmsStats.maxRmsDb)) obj.put("max_rms_db", rmsStats.maxRmsDb);
            if (!Float.isNaN(rmsStats.getBaselineRmsDb())) obj.put("baseline_rms_db", rmsStats.getBaselineRmsDb());
            obj.put("t_ms", now);
            if (currentTiming != null) {
                obj.put("attempt_id", currentTiming.attemptId);
                if (currentTiming.expectedLetter != null) {
                    obj.put("expected_letter", currentTiming.expectedLetter);
                }
            }

            PluginResult pr = new PluginResult(PluginResult.Status.OK, obj);
            pr.setKeepCallback(true);
            currentCallback.sendPluginResult(pr);
        } catch (JSONException e) {
            Log.w(TAG, "Failed to send RMS update", e);
        }
    }

    private void sendMilestoneEvent(String stage, JSONObject extras) {
        if (currentCallback == null || currentTiming == null) {
            return;
        }

        try {
            JSONObject obj = new JSONObject();
            obj.put("type", "event");
            obj.put("event", stage);
            obj.put("attempt_id", currentTiming.attemptId);
            if (currentTiming.expectedLetter != null) {
                obj.put("expected_letter", currentTiming.expectedLetter);
            }
            obj.put("timing", buildTimingJson(currentTiming));
            if (extras != null) {
                JSONObject extrasCopy = new JSONObject(extras.toString());
                obj.put("extras", extrasCopy);
            }

            PluginResult pr = new PluginResult(PluginResult.Status.OK, obj);
            pr.setKeepCallback(true);
            currentCallback.sendPluginResult(pr);
        } catch (JSONException e) {
            Log.w(TAG, "Failed to send milestone event " + stage, e);
        }
    }

    private String mapErrorLabel(int error) {
        switch (error) {
            case SpeechRecognizer.ERROR_NO_MATCH:
                return "ERROR_NO_MATCH";
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                return "ERROR_SPEECH_TIMEOUT";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                return "ERROR_INSUFFICIENT_PERMISSIONS";
            case SpeechRecognizer.ERROR_AUDIO:
                return "ERROR_AUDIO";
            case SpeechRecognizer.ERROR_NETWORK:
                return "ERROR_NETWORK";
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                return "ERROR_NETWORK_TIMEOUT";
            case SpeechRecognizer.ERROR_CLIENT:
                return "ERROR_CLIENT";
            case SpeechRecognizer.ERROR_SERVER:
                return "ERROR_SERVER";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                return "ERROR_RECOGNIZER_BUSY";
            case SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED:
                return "ERROR_LANGUAGE_NOT_SUPPORTED";
            case SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE:
                return "ERROR_LANGUAGE_UNAVAILABLE";
            case SpeechRecognizer.ERROR_SERVER_DISCONNECTED:
                return "ERROR_SERVER_DISCONNECTED";
            default:
                return "ERROR_UNKNOWN_" + error;
        }
    }

    private void updateThresholdConfigFromOptions(JSONObject opts) {
        ThresholdConfig defaults = ThresholdConfig.defaults();
        float start = defaults.rmsStartThresholdDb;
        float end = defaults.rmsEndThresholdDb;
        long postSilence = defaults.postSilenceMs;
        long minPostSilence = defaults.minPostSilenceMs;
        long maxUtterance = defaults.maxUtteranceMs;

        if (opts != null) {
            if (opts.has("rmsEndThresholdDb")) {
                double candidate = opts.optDouble("rmsEndThresholdDb", Double.NaN);
                if (!Double.isNaN(candidate)) {
                    end = Math.min((float) candidate, RMS_END_THRESHOLD_DB);
                }
            }
            if (opts.has("postSilenceMs")) {
                double candidate = opts.optDouble("postSilenceMs", Double.NaN);
                if (!Double.isNaN(candidate) && candidate >= MIN_POST_SILENCE_MS) {
                    postSilence = (long) candidate;
                }
            }
            if (opts.has("minPostSilenceMs")) {
                double candidate = opts.optDouble("minPostSilenceMs", Double.NaN);
                if (!Double.isNaN(candidate) && candidate >= MIN_POST_SILENCE_MS) {
                    minPostSilence = (long) candidate;
                }
            }
            if (opts.has("maxUtteranceMs")) {
                double candidate = opts.optDouble("maxUtteranceMs", Double.NaN);
                if (!Double.isNaN(candidate) && candidate >= MAX_UTTERANCE_MS) {
                    maxUtterance = (long) candidate;
                }
            }
            if (opts.has("rmsStartThresholdDb")) {
                Log.i(TAG, "Ignoring rmsStartThresholdDb override; start gate is disabled");
            }
        }

        postSilence = Math.max(postSilence, minPostSilence);
        ThresholdConfig newConfig = new ThresholdConfig(start, end, RMS_RESUME_DELTA_DB, postSilence, minPostSilence, maxUtterance, RMS_VOICE_TRIGGER_DB, RMS_SMOOTH_TAIL_SAMPLES, SILENCE_HOLD_MS);
        thresholdConfig.set(newConfig);
        Log.i(TAG, "Threshold config updated start=" + start +
                " end=" + end +
                " postSilenceMs=" + postSilence +
                " minPostSilenceMs=" + minPostSilence +
                " maxUtteranceMs=" + maxUtterance);
    }

    private JSONObject buildCommitExtras(String reason, boolean includePartialInfo) {
        JSONObject extras = new JSONObject();
        try {
            extras.put("commit_reason", reason);
            JSONArray tail = rmsStats.recentSamplesToJson();
            if (tail != null) {
                extras.put("rms_tail", tail);
            }
            if (!Float.isNaN(rmsStats.getBaselineRmsDb())) {
                extras.put("baseline_rms_db", rmsStats.getBaselineRmsDb());
            }
            if (includePartialInfo) {
                extras.put("partial_results_seen", partialResultsSeen);
                extras.put("partial_results_count", lastPartialResults == null ? 0 : lastPartialResults.size());
            }
        } catch (JSONException e) {
            Log.w(TAG, "Failed to build commit extras", e);
            return null;
        }
        return extras;
    }

    private void updateRecognizerServiceFromOptions(JSONObject opts) {
        if (opts == null) return;

        if (opts.has("recognizerService")) {
            String candidate = opts.optString("recognizerService", "").trim();
            if (candidate.isEmpty()) {
                recognizerServiceOverride = null;
                Log.i(TAG, "Recognizer service override cleared (empty string)");
                return;
            }
            ComponentName cn = ComponentName.unflattenFromString(candidate);
            if (cn != null) {
                recognizerServiceOverride = cn;
                Log.i(TAG, "Recognizer service override set to " + cn.flattenToShortString());
            } else {
                Log.w(TAG, "Invalid recognizerService override: " + candidate);
            }
        }
    }
}
