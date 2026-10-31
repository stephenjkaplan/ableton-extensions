// Throwaway. Everything goes to Node, which logs it, so nobody has to read the Max window.
inlets = 1;
outlets = 1;

function log(kind, data) { outlet(0, "log", JSON.stringify({ from: "v8", kind: kind, data: data })); }
function first(api, prop) { var v = api.get(prop); return v && v.length === 1 ? v[0] : v; }

function selectedClip() {
  var api = new LiveAPI("live_set view detail_clip");
  if (Number(api.id) === 0) { log("error", "no clip selected"); return null; }
  return api;
}

function run() {
  var clip = selectedClip();
  if (!clip) return;
  var props = ["name", "is_audio_clip", "gain", "gain_display_string", "file_path", "warping", "looping", "muted",
               "loop_start", "loop_end", "start_marker", "end_marker", "sample_length", "sample_rate", "warp_markers"];
  var info = { path: clip.unquotedpath };
  for (var i = 0; i < props.length; i++) {
    try { info[props[i]] = clip.get(props[i]); } catch (e) { info[props[i]] = "ERROR " + e; }
  }
  log("clip", info);

  var song = new LiveAPI("live_set");
  log("set", { file_path: song.get("file_path"), tracks: song.getcount("tracks"), can_undo: song.get("can_undo") });

  var original = first(clip, "gain");
  for (var step = 0; step <= 100; step++) {
    var raw = step / 100;
    clip.set("gain", raw);
    outlet(0, "sweep", JSON.stringify([raw, first(clip, "gain"), clip.get("gain_display_string").join(" ")]));
  }
  clip.set("gain", original);
  log("restored", { wanted: original, got: first(clip, "gain"), exact: first(clip, "gain") === original });
  scan(song);
  undoProbe(clip, original);
}

function scan(song) {
  var started = Date.now(), audio = 0, arrangement = 0, tracks = song.getcount("tracks");
  var slot = new LiveAPI("live_set"), clip = new LiveAPI("live_set");
  for (var t = 0; t < tracks; t++) {
    var slots = new LiveAPI("live_set tracks " + t).getcount("clip_slots");
    for (var s = 0; s < slots; s++) {
      slot.path = "live_set tracks " + t + " clip_slots " + s;
      if (Number(first(slot, "has_clip"))) {
        clip.path = slot.unquotedpath + " clip";
        if (Number(first(clip, "is_audio_clip"))) audio++;
      }
    }
    arrangement += new LiveAPI("live_set tracks " + t).getcount("arrangement_clips");
  }
  log("scan", { tracks: tracks, sessionAudioClips: audio, arrangementClips: arrangement, ms: Date.now() - started });
}

// Writes one value per scheduler tick, as a real Apply would, then undoes until the gain is back.
function undoProbe(clip, original) {
  var song = new LiveAPI("live_set");
  var values = [0.5, 0.6, 0.7], i = 0, undos = 0, seen = [];
  var task = new Task(function () {
    if (i < values.length) {
      clip.set("gain", values[i++]);
      return;
    }
    var now = first(clip, "gain");
    if (Math.abs(now - original) < 1e-9 || undos >= 6) {
      log("undo_probe", { original: original, undos: undos, seen: seen, backToOriginal: Math.abs(now - original) < 1e-9 });
      clip.set("gain", original);
      task.cancel();
      return;
    }
    song.call("undo");
    undos++;
    seen.push(first(clip, "gain"));
  });
  task.interval = 200;
  task.repeat();
}

function hello() { log("hello", "main v8 loaded by absolute path"); }
