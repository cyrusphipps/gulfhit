package com.limetuna.speech;

import android.Manifest;
import android.app.Activity;
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

import java.util.ArrayList;

public class LimeTunaSpeech extends CordovaPlugin implements RecognitionListener {

    private static final String TAG = "LimeTunaSpeech";
    private static final int REQ_RECORD_AUDIO = 7001;
    // Debug-only speech indicator thresholds. Keep these in sync with
    // www/js/letters.js so we can retune or remove the indicator together.
    // RMS_VOICE_TRIGGER_DB: first RMS level we count as "speech started" for
    // timing indicator purposes (not an ASR gate).
    private static final float RMS_VOICE_TRIGGER_DB = -2.0f;

    // Recognizer RMS values typically floor around -2 dB. Consider values
    // >= ~3-4 dB as the beginning of speech, and drop below ~2-3 dB as silence.
    private static final float RMS_START_THRESHOLD_DB = 3.4f;
    private static final float RMS_END_THRESHOLD_DB = 2.4f;
    private static final long POST_SILENCE_MS = 800L;
    private static final long MAX_UTTERANCE_MS = 3300L;

    private SpeechRecognizer speechRecognizer;
    private CallbackContext currentCallback;

    private String language = "en-US";

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

    private AttemptTiming currentTiming;
    private long attemptCounter = 0L;
    private RmsStats rmsStats = new RmsStats();
    private long lastRmsDispatchMs = 0L;
    private static final long RMS_DISPATCH_INTERVAL_MS = 80L;
    private static final float RMS_AVG_ALPHA = 0.2f;

    private enum ListeningState {
        IDLE,
        SPEECH,
        SILENCE_WINDOW,
        COMMIT
    }

    private static class RmsStats {
        float lastRmsDb = Float.NaN;
        float avgRmsDb = Float.NaN;
        float minRmsDb = Float.NaN;
        float maxRmsDb = Float.NaN;
        long lastUpdateMs = 0L;

        void reset() {
            lastRmsDb = Float.NaN;
            avgRmsDb = Float.NaN;
            minRmsDb = Float.NaN;
            maxRmsDb = Float.NaN;
            lastUpdateMs = 0L;
        }

        void update(float rmsDb, long nowMs) {
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
        }

        JSONObject toJson() throws JSONException {
            JSONObject obj = new JSONObject();
            if (!Float.isNaN(lastRmsDb)) obj.put("last_rms_db", lastRmsDb);
            if (!Float.isNaN(avgRmsDb)) obj.put("avg_rms_db", avgRmsDb);
            if (!Float.isNaN(minRmsDb)) obj.put("min_rms_db", minRmsDb);
            if (!Float.isNaN(maxRmsDb)) obj.put("max_rms_db", maxRmsDb);
            if (lastUpdateMs > 0) obj.put("last_update_ms", lastUpdateMs);
            if (obj.length() == 0) return null;
            return obj;
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

            speechRecognizer = SpeechRecognizer.createSpeechRecognizer(
                    cordova.getActivity().getApplicationContext()
            );
            speechRecognizer.setRecognitionListener(this);
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

                currentCallback = callbackContext;
                isListening = true;
                stopIssued = false;
                listeningState = ListeningState.IDLE;
                cancelSilenceTimer(true);
                rmsStats.reset();
                lastRmsDispatchMs = 0L;

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
                intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE,
                        cordova.getActivity().getPackageName());
                intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 10);
                intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
                intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, false);

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
        if (currentTiming != null && currentTiming.nativeFirstRmsAboveThresholdMs == 0 && rmsdB > RMS_VOICE_TRIGGER_DB) {
            currentTiming.nativeFirstRmsAboveThresholdMs = SystemClock.elapsedRealtime();
            Log.d(TAG, "LimeTunaSpeech stage=rms_threshold t=" + currentTiming.nativeFirstRmsAboveThresholdMs + " rmsdB=" + rmsdB);
        }

        if (!isListening) {
            return;
        }

        long now = SystemClock.elapsedRealtime();

        switch (listeningState) {
            case IDLE:
                if (rmsdB >= RMS_START_THRESHOLD_DB) {
                    listeningState = ListeningState.SPEECH;
                    ensureRmsSpeechStart(now);
                    cancelSilenceTimer(true);
                }
                break;
            case SPEECH:
                if (rmsdB < RMS_END_THRESHOLD_DB) {
                    beginSilenceWindow(now);
                }
                break;
            case SILENCE_WINDOW: {
                if (rmsdB >= RMS_START_THRESHOLD_DB) {
                    cancelSilenceTimer(true);
                    listeningState = ListeningState.SPEECH;
                    ensureRmsSpeechStart(now);
                }
                break;
            }
            case COMMIT:
                // Waiting for commit; ignore further RMS.
                break;
        }

        if (isListening) {
            sendRmsUpdateToCallback(rmsdB);
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
        // not used
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

        JSONObject thresholds = new JSONObject();
        thresholds.put("rms_voice_trigger_db", RMS_VOICE_TRIGGER_DB);
        thresholds.put("rms_start_threshold_db", RMS_START_THRESHOLD_DB);
        thresholds.put("rms_end_threshold_db", RMS_END_THRESHOLD_DB);
        thresholds.put("post_silence_ms", POST_SILENCE_MS);
        thresholds.put("max_utterance_ms", MAX_UTTERANCE_MS);

        timingJson.put("native_raw", raw);
        timingJson.put("native_durations", durations);
        timingJson.put("native_thresholds", thresholds);

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
        if (currentTiming != null && currentTiming.nativeRmsSpeechEndMs == 0) {
            currentTiming.nativeRmsSpeechEndMs = now;
        }

        cancelSpeechFailSafe();
        sendMilestoneEvent("enter_silence_window", null);

        if (handler != null) {
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
                    stopListeningInternal(false);
                }
            };
            handler.postDelayed(silenceTimeoutRunnable, POST_SILENCE_MS);
        }
    }

    private void cancelSilenceTimer(boolean clearEndTime) {
        if (handler != null && silenceTimeoutRunnable != null) {
            handler.removeCallbacks(silenceTimeoutRunnable);
        }
        silenceTimeoutRunnable = null;
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
                    sendMilestoneEvent("failsafe_commit", null);
                    stopListeningInternal(false);
                }
            };
            handler.postDelayed(speechFailSafeRunnable, MAX_UTTERANCE_MS);
        }
    }

    private void cancelSpeechFailSafe() {
        if (handler != null && speechFailSafeRunnable != null) {
            handler.removeCallbacks(speechFailSafeRunnable);
        }
        speechFailSafeRunnable = null;
    }

    private void resetListeningState() {
        cancelSilenceTimer(false);
        cancelSpeechFailSafe();
        listeningState = ListeningState.IDLE;
        stopIssued = false;
    }

    private void sendRmsUpdateToCallback(float rmsdB) {
        if (currentCallback == null) {
            return;
        }

        long now = SystemClock.elapsedRealtime();
        rmsStats.update(rmsdB, now);

        if (lastRmsDispatchMs > 0 && (now - lastRmsDispatchMs) < RMS_DISPATCH_INTERVAL_MS) {
            return;
        }
        lastRmsDispatchMs = now;

        try {
            JSONObject obj = new JSONObject();
            obj.put("type", "rms");
            obj.put("rms_db", rmsStats.lastRmsDb);
            if (!Float.isNaN(rmsStats.avgRmsDb)) obj.put("avg_rms_db", rmsStats.avgRmsDb);
            if (!Float.isNaN(rmsStats.minRmsDb)) obj.put("min_rms_db", rmsStats.minRmsDb);
            if (!Float.isNaN(rmsStats.maxRmsDb)) obj.put("max_rms_db", rmsStats.maxRmsDb);
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
}
