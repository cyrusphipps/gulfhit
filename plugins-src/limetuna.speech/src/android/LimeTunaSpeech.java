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

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;

public class LimeTunaSpeech extends CordovaPlugin implements RecognitionListener {

    private static final String TAG = "LimeTunaSpeech";
    private static final int REQ_RECORD_AUDIO = 7001;

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

    private AttemptTiming currentTiming;

    private static class AttemptTiming {
        long nativeReceivedMs;
        long nativeStartListeningMs;
        long nativeReadyForSpeechMs;
        long nativeBeginningOfSpeechMs;
        long nativeFirstRmsAboveThresholdMs;
        long nativeEndOfSpeechMs;
        long nativeFirstPartialMs;
        long nativeResultsMs;
        long nativeErrorMs;
        long nativeNormalizeDoneMs;
        long nativeCallbackSentMs;

        String expectedLetter;
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

                AttemptTiming timing = new AttemptTiming();
                timing.nativeReceivedMs = SystemClock.elapsedRealtime();
                timing.expectedLetter = (args != null && args.length() > 0) ? args.optString(0, null) : null;

                JSONObject startOpts = null;
                if (args != null && args.length() > 1 && !args.isNull(1)) {
                    startOpts = args.optJSONObject(1);
                }
                currentTiming = timing;
                Log.d(TAG, "LimeTunaSpeech stage=received t=" + timing.nativeReceivedMs + " expected=" + timing.expectedLetter);

                Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                        chooseLanguageModel(startOpts));
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
                intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE,
                        cordova.getActivity().getPackageName());
                intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 10);
                intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);

                applyLatencyTuningExtras(intent, startOpts);

                try {
                    if (currentTiming != null) {
                        currentTiming.nativeStartListeningMs = SystemClock.elapsedRealtime();
                        Log.d(TAG, "LimeTunaSpeech stage=startListening t=" + currentTiming.nativeStartListeningMs);
                    }
                    Log.d(TAG, "Calling startListening");
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

    private void ensureTimingAnchors(AttemptTiming timing) {
        if (timing == null) return;

        if (timing.nativeStartListeningMs <= 0 && timing.nativeReceivedMs > 0) {
            timing.nativeStartListeningMs = timing.nativeReceivedMs;
        }

        if (timing.nativeReadyForSpeechMs <= 0 && timing.nativeStartListeningMs > 0) {
            timing.nativeReadyForSpeechMs = timing.nativeStartListeningMs;
        }

        if (timing.nativeBeginningOfSpeechMs <= 0) {
            if (timing.nativeFirstRmsAboveThresholdMs > 0) {
                timing.nativeBeginningOfSpeechMs = timing.nativeFirstRmsAboveThresholdMs;
            } else if (timing.nativeReadyForSpeechMs > 0) {
                timing.nativeBeginningOfSpeechMs = timing.nativeReadyForSpeechMs;
            }
        }

        if (timing.nativeEndOfSpeechMs <= 0 && timing.nativeResultsMs > 0) {
            if (timing.nativeFirstPartialMs > 0) {
                timing.nativeEndOfSpeechMs = timing.nativeFirstPartialMs;
            } else {
                timing.nativeEndOfSpeechMs = timing.nativeResultsMs;
            }
        }

        if (timing.nativeNormalizeDoneMs <= 0 && timing.nativeResultsMs > 0) {
            timing.nativeNormalizeDoneMs = timing.nativeResultsMs;
        }

        if (timing.nativeCallbackSentMs <= 0 && timing.nativeResultsMs > 0) {
            timing.nativeCallbackSentMs = timing.nativeResultsMs;
        }
    }

    private void sendErrorToCallback(String code, String message, AttemptTiming timing) {
        if (currentCallback != null) {
            try {
                if (timing != null) {
                    timing.nativeErrorMs = SystemClock.elapsedRealtime();
                    timing.nativeCallbackSentMs = timing.nativeErrorMs;
                    ensureTimingAnchors(timing);
                }
                JSONObject obj = buildErrorJsonObject(code, message, timing);
                currentCallback.error(obj.toString());
            } catch (JSONException e) {
                currentCallback.error(buildErrorJson(code, message));
            }
            currentCallback = null;
        }
        isListening = false;
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
                    timing.nativeCallbackSentMs = SystemClock.elapsedRealtime();
                    ensureTimingAnchors(timing);
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
        currentTiming = null;
    }

    private void stopListeningInternal(boolean cancel) {
        if (speechRecognizer != null && isListening) {
            try {
                if (cancel) {
                    speechRecognizer.cancel();
                } else {
                    speechRecognizer.stopListening();
                }
            } catch (Exception e) {
                Log.w(TAG, "Error stopping recognizer", e);
            }
        }
        isListening = false;
    }

    // RecognitionListener ------------------------------------------------------

    @Override
    public void onReadyForSpeech(Bundle params) {
        Log.d(TAG, "onReadyForSpeech");
        if (currentTiming != null) {
            currentTiming.nativeReadyForSpeechMs = SystemClock.elapsedRealtime();
            Log.d(TAG, "LimeTunaSpeech stage=ready t=" + currentTiming.nativeReadyForSpeechMs);
        }
    }

    @Override
    public void onBeginningOfSpeech() {
        Log.d(TAG, "onBeginningOfSpeech");
        if (currentTiming != null) {
            currentTiming.nativeBeginningOfSpeechMs = SystemClock.elapsedRealtime();
            Log.d(TAG, "LimeTunaSpeech stage=begin_speech t=" + currentTiming.nativeBeginningOfSpeechMs);
        }
    }

    @Override
    public void onRmsChanged(float rmsdB) {
        Log.v(TAG, "onRmsChanged: " + rmsdB);
        if (currentTiming != null && currentTiming.nativeFirstRmsAboveThresholdMs == 0 && rmsdB > -2.0f) {
            currentTiming.nativeFirstRmsAboveThresholdMs = SystemClock.elapsedRealtime();
            Log.d(TAG, "LimeTunaSpeech stage=rms_threshold t=" + currentTiming.nativeFirstRmsAboveThresholdMs + " rmsdB=" + rmsdB);
        }
    }

    @Override
    public void onBufferReceived(byte[] buffer) {
        // not used
    }

    @Override
    public void onEndOfSpeech() {
        Log.d(TAG, "onEndOfSpeech");
        if (currentTiming != null) {
            currentTiming.nativeEndOfSpeechMs = SystemClock.elapsedRealtime();
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
        Log.d(TAG, "onPartialResults");

        if (!isListening && currentCallback == null) {
            return;
        }

        if (currentTiming != null && currentTiming.nativeFirstPartialMs <= 0) {
            currentTiming.nativeFirstPartialMs = SystemClock.elapsedRealtime();
            Log.d(TAG, "LimeTunaSpeech stage=first_partial t=" + currentTiming.nativeFirstPartialMs);
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
        currentTiming = null;

        // Safety: restore volumes if we die while muted
        applyBeepsMuted(false);
    }

    private JSONObject buildErrorJsonObject(String code, String message, AttemptTiming timing) throws JSONException {
        JSONObject err = new JSONObject();
        err.put("code", code);
        err.put("message", message);
        if (timing != null) {
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
        putIfPositive(raw, "native_endOfSpeech_ms", timing.nativeEndOfSpeechMs);
        putIfPositive(raw, "native_firstPartial_ms", timing.nativeFirstPartialMs);
        putIfPositive(raw, "native_results_ms", timing.nativeResultsMs);
        putIfPositive(raw, "native_error_ms", timing.nativeErrorMs);
        putIfPositive(raw, "native_normalize_done_ms", timing.nativeNormalizeDoneMs);
        putIfPositive(raw, "native_callback_sent_ms", timing.nativeCallbackSentMs);

        if (timing.expectedLetter != null) {
            raw.put("expected_letter", timing.expectedLetter);
        }

        JSONObject durations = new JSONObject();
        putDuration(durations, "d_queue_native_ms", timing.nativeStartListeningMs, timing.nativeReceivedMs);
        putDuration(durations, "d_engine_ready_ms", timing.nativeReadyForSpeechMs, timing.nativeStartListeningMs);

        long speechAnchorStart = timing.nativeReadyForSpeechMs > 0 ? timing.nativeReadyForSpeechMs : timing.nativeStartListeningMs;
        long speechAnchorEnd = timing.nativeBeginningOfSpeechMs > 0 ? timing.nativeBeginningOfSpeechMs : timing.nativeFirstRmsAboveThresholdMs;
        putDuration(durations, "d_user_speech_to_engine_ms", speechAnchorEnd, speechAnchorStart);

        putDuration(durations, "d_engine_processing_ms", timing.nativeResultsMs, timing.nativeEndOfSpeechMs);
        putDuration(durations, "d_normalize_ms", timing.nativeNormalizeDoneMs, timing.nativeResultsMs);
        putDuration(durations, "d_first_partial_ms", timing.nativeFirstPartialMs, timing.nativeEndOfSpeechMs);
        putDuration(durations, "d_final_after_partial_ms", timing.nativeResultsMs, timing.nativeFirstPartialMs);

        timingJson.put("native_raw", raw);
        timingJson.put("native_durations", durations);

        return timingJson;
    }

    private String chooseLanguageModel(JSONObject startOpts) {
        if (startOpts != null) {
            String model = startOpts.optString("languageModel", null);
            if ("free_form".equalsIgnoreCase(model)) {
                return RecognizerIntent.LANGUAGE_MODEL_FREE_FORM;
            }
            if ("web_search".equalsIgnoreCase(model)) {
                return RecognizerIntent.LANGUAGE_MODEL_WEB_SEARCH;
            }
        }
        // default: stick with web search (good for short utterances)
        return RecognizerIntent.LANGUAGE_MODEL_WEB_SEARCH;
    }

    private void applyLatencyTuningExtras(Intent intent, JSONObject startOpts) {
        int completeSilenceMs = 700;
        int possibleSilenceMs = 500;
        boolean preferOffline = false;
        boolean allowCloudFallback = true;

        if (startOpts != null) {
            completeSilenceMs = startOpts.optInt("completeSilenceMs", completeSilenceMs);
            possibleSilenceMs = startOpts.optInt("possibleSilenceMs", possibleSilenceMs);
            preferOffline = startOpts.optBoolean("preferOffline", preferOffline);
            allowCloudFallback = startOpts.optBoolean("allowCloudFallback", allowCloudFallback);
        }

        intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, completeSilenceMs);
        intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, possibleSilenceMs);

        // When offline packs are installed, this reduces latency; fallback behavior depends on engine availability
        boolean preferOfflineFinal = preferOffline;
        if (!allowCloudFallback && preferOffline) {
            // caller explicitly wants offline-only; keep hint true so failures surface quickly
            preferOfflineFinal = true;
        }
        intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, preferOfflineFinal);
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
}
