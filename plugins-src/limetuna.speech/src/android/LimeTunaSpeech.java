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
                    Log.d(TAG, "Calling startListening");
                    speechRecognizer.startListening(intent);
                } catch (Exception e) {
                    Log.e(TAG, "startListening failed", e);
                    sendErrorToCallback("START_FAILED", "Failed to start listening");
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

    private void sendErrorToCallback(String code, String message) {
        if (currentCallback != null) {
            currentCallback.error(buildErrorJson(code, message));
            currentCallback = null;
        }
        isListening = false;
    }

    private void sendSuccessToCallback(String text, Float confidence,
                                       ArrayList<String> all, float[] confs) {

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

                currentCallback.success(json.toString());
            } catch (JSONException e) {
                Log.e(TAG, "Error building success JSON", e);
                currentCallback.success(text != null ? text : "");
            }

            currentCallback = null;
        }

        isListening = false;
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
    }

    @Override
    public void onBeginningOfSpeech() {
        Log.d(TAG, "onBeginningOfSpeech");
    }

    @Override
    public void onRmsChanged(float rmsdB) {
        Log.v(TAG, "onRmsChanged: " + rmsdB);
    }

    @Override
    public void onBufferReceived(byte[] buffer) {
        // not used
    }

    @Override
    public void onEndOfSpeech() {
        Log.d(TAG, "onEndOfSpeech");
    }

    @Override
    public void onError(int error) {
        Log.d(TAG, "onError: " + error);

        if (!isListening && currentCallback == null) {
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
            default:
                code = "ERROR_" + error;
                break;
        }

        sendErrorToCallback(code, "Speech recognition error");
    }

    @Override
    public void onResults(Bundle results) {
        Log.d(TAG, "onResults");

        if (!isListening && currentCallback == null) {
            return;
        }

        ArrayList<String> matches =
                results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        float[] confidences =
                results.getFloatArray(SpeechRecognizer.CONFIDENCE_SCORES);

        Log.d(TAG, "matches=" + matches + " confidences=" + (confidences == null ? "null" : confidences.length));

        if (matches == null || matches.isEmpty()) {
            sendErrorToCallback("NO_MATCH", "No recognition result");
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

        sendSuccessToCallback(bestText, bestConf, matches, confidences);
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

        // Safety: restore volumes if we die while muted
        applyBeepsMuted(false);
    }
}
