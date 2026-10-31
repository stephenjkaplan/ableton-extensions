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

function scan() {
  try {
    var song = new LiveAPI("live_set");
    var tracks = song.getcount("tracks");
    var clip = new LiveAPI("live_set");
    for (var t = 0; t < tracks; t++) {
      var track = new LiveAPI("live_set tracks " + t);
      var trackName = text(track, "name");
      var slots = track.getcount("clip_slots");
      for (var s = 0; s < slots; s++) {
        if (!Number(value(new LiveAPI("live_set tracks " + t + " clip_slots " + s), "has_clip"))) continue;
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
    send("scan_done", { setPath: text(song, "file_path") });
  } catch (e) {
    send("bridge_error", String(e));
  }
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
