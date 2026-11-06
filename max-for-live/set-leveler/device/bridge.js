// Runs in Max's v8 object: the only code that touches Live. It reads clips and sets clip gain, nothing else.
// Sends one message per clip, URI-encoded, so no message gets large and no name can confuse Max.
inlets = 1;
outlets = 1;

function send(kind, data) { outlet(0, kind, encodeURIComponent(JSON.stringify(data))); }
function value(api, prop) { return api.get(prop)[0]; }
function text(api, prop) {
  var v = api.get(prop);
  return v && v.join ? v.join(" ") : ""; // an unsaved Set has no file_path
}

function markers(clip) {
  try {
    var list = JSON.parse(clip.get("warp_markers")[0]).warp_markers;
    return list.map(function (m) { return { beatTime: m.beat_time, sampleTime: m.sample_time }; });
  } catch (e) {
    return [];
  }
}

function readTrack(t, slot, clip) {
  var track = new LiveAPI("live_set tracks " + t);
  var trackName = text(track, "name");
  var slots = track.getcount("clip_slots");
  for (var s = 0; s < slots; s++) {
    slot.path = "live_set tracks " + t + " clip_slots " + s;
    if (!Number(value(slot, "has_clip"))) continue;
    clip.path = "live_set tracks " + t + " clip_slots " + s + " clip";
    if (!Number(value(clip, "is_audio_clip"))) continue;
    send("clip", {
      key: t + ":" + s, trackIndex: t, slotIndex: s, trackName: trackName, name: text(clip, "name"),
      filePath: text(clip, "file_path"), rawGain: value(clip, "gain"), warping: Number(value(clip, "warping")) === 1,
      loopStart: value(clip, "loop_start"), loopEnd: value(clip, "loop_end"), warpMarkers: markers(clip),
    });
  }
  var placed = Number(value(track, "is_foldable")) ? 0 : track.getcount("arrangement_clips"); // group tracks have none
  for (var a = 0; a < placed; a++) {
    clip.path = "live_set tracks " + t + " arrangement_clips " + a;
    if (!Number(value(clip, "is_audio_clip"))) continue;
    send("arr", { filePath: text(clip, "file_path"), start: value(clip, "start_time"), end: value(clip, "end_time") });
  }
}

// One track per tick. A Set can have thousands of slots, and reading them in one go freezes Live.
var scanning = null;

function scan() {
  if (scanning) scanning.cancel();
  var t = 0;
  var song = new LiveAPI("live_set");
  var tracks = song.getcount("tracks");
  var slot = new LiveAPI("live_set");
  var clip = new LiveAPI("live_set");
  var task = new Task(function () {
    try {
      if (t < tracks) {
        readTrack(t, slot, clip);
        t++;
        send("scan_progress", { done: t, total: tracks });
        return;
      }
      task.cancel();
      scanning = null;
      send("scan_done", { setPath: text(song, "file_path") });
    } catch (e) {
      task.cancel();
      scanning = null;
      send("bridge_error", String(e));
    }
  });
  scanning = task;
  task.interval = 1;
  task.repeat();
}

// In case Max delivers route's output as "symbol scan" rather than "scan".
function symbol(s) { if (s === "scan") scan(); }

function setgain(track, slot, raw) {
  var reply = { trackIndex: track, slotIndex: slot, value: null };
  try {
    var clip = new LiveAPI("live_set tracks " + track + " clip_slots " + slot + " clip");
    if (Number(clip.id) !== 0) {
      clip.set("gain", raw);
      reply.value = value(clip, "gain");
    }
  } catch (e) {
    reply.error = String(e);
  }
  send("gain_set", reply);
}
