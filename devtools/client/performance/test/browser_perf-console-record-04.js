/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */
"use strict";

/**
 * Tests that the profiler can handle creation and stopping of console profiles
 * after being opened.
 */

const { Constants } = require("devtools/client/performance/modules/constants");
const { SIMPLE_URL } = require("devtools/client/performance/test/helpers/urls");
const { initPerformanceInTab, initConsoleInNewTab, teardownToolboxAndRemoveTab } = require("devtools/client/performance/test/helpers/panel-utils");
const { waitForRecordingStartedEvents, waitForRecordingStoppedEvents } = require("devtools/client/performance/test/helpers/actions");
const { times } = require("devtools/client/performance/test/helpers/event-utils");

add_task(function* () {
  let { target, console } = yield initConsoleInNewTab({
    url: SIMPLE_URL,
    win: window
  });

  let { panel } = yield initPerformanceInTab({ tab: target.tab });
  let { EVENTS, PerformanceController, OverviewView, RecordingsView } = panel.panelWin;

  let started = waitForRecordingStartedEvents(panel, {
    // only emitted for manual recordings
    skipWaitingForBackendReady: true
  });
  yield console.profile("rust");
  yield started;

  let recordings = PerformanceController.getRecordings();
  is(recordings.length, 1, "One recording found in the performance panel.");
  is(recordings[0].isConsole(), true, "Recording came from console.profile.");
  is(recordings[0].getLabel(), "rust", "Correct label in the recording model.");
  is(recordings[0].isRecording(), true, "Recording is still recording.");

  is(RecordingsView.selectedItem.attachment, recordings[0],
    "The profile from console should be selected as it's the only one.");
  is(RecordingsView.selectedItem.attachment.getLabel(), "rust",
    "The profile label for the first recording is correct.");

  // Ensure overview is still rendering.
  yield times(OverviewView, EVENTS.UI_OVERVIEW_RENDERED, 3, {
    expectedArgs: { "1": Constants.FRAMERATE_GRAPH_LOW_RES_INTERVAL }
  });

  let stopped = waitForRecordingStoppedEvents(panel, {
    // only emitted for manual recordings
    skipWaitingForBackendReady: true
  });
  yield console.profileEnd("rust");
  yield stopped;

  yield teardownToolboxAndRemoveTab(panel);
});
