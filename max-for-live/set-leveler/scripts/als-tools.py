#!/usr/bin/env python3
"""Read-only helpers for .als files. Never writes to one.

  als-tools.py fixture <set.als> > layout.json   A LiveScan of the Set, file basenames only.
"""
import gzip
import json
import os
import sys
import xml.etree.ElementTree as ET


def load(path):
    return ET.fromstring(gzip.open(path, "rb").read()).find("LiveSet")


def file_of(clip):
    return clip.find(".//SampleRef/FileRef/Path").get("Value")


def track_name(track):
    return track.find("Name/EffectiveName").get("Value")


def session_clips(track):
    """(slot index, clip element) for each Session audio clip on a track."""
    for slot_index, slot in enumerate(track.findall(".//ClipSlotList/ClipSlot")):
        for clip in slot.iter("AudioClip"):
            yield slot_index, clip


def fixture(path):
    live_set = load(path)
    session, arrangement, candidates = [], [], []
    for track_index, track in enumerate(live_set.find("Tracks")):
        if track.tag == "ReturnTrack":
            continue
        in_session = set()
        name = track_name(track)
        for slot_index, clip in session_clips(track):
            in_session.add(id(clip))
            loop = clip.find("Loop")
            session.append({
                "key": f"{track_index}:{slot_index}", "trackIndex": track_index, "slotIndex": slot_index,
                "trackName": name, "name": clip.find("Name").get("Value"),
                "filePath": os.path.basename(file_of(clip)), "rawGain": 0.4,
                "warping": clip.find("IsWarped").get("Value") == "true",
                "loopStart": float(loop.find("LoopStart").get("Value")),
                "loopEnd": float(loop.find("LoopEnd").get("Value")),
                "warpMarkers": [],
            })
        if in_session and name not in [c["trackName"] for c in candidates]:
            candidates.append({"trackIndex": track_index, "trackName": name})
        for clip in track.iter("AudioClip"):
            if id(clip) not in in_session:
                arrangement.append({
                    "filePath": os.path.basename(file_of(clip)),
                    "start": float(clip.find("CurrentStart").get("Value")),
                    "end": float(clip.find("CurrentEnd").get("Value")),
                })
    return {"setPath": "/fixture/Halloween Party DJ Set.als", "session": session, "arrangement": arrangement,
            "layerCandidates": candidates}


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "fixture":
        json.dump(fixture(sys.argv[2]), sys.stdout, indent=1)
        print()
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main())
