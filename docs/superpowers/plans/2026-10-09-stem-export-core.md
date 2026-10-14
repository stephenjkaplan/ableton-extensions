# Stem Export Core Implementation Plan

> **SUPERSEDED 2026-10-09** — replaced by `2026-10-09-stem-export-extension.md`. This plan
> targeted a Python offline core before we discovered the Live 12.4 Extensions SDK. Kept for
> the rejected-approach record only; do not implement it.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Python package + CLI that reads an Ableton `.als` read-only, records and validates a track→stem mapping stored beside the project, tells you exactly what to exclude for each render pass, and then names, files, level-normalizes and null-tests the resulting stems.

**Architecture:** Pure offline core, no Live dependency. `als.py` parses the gzipped XML into an immutable `Project`; `manifest.py` persists the mapping as YAML beside the `.als`; `validate.py` and `plan.py` are pure functions over those two; `audio.py` and `postprocess.py` handle the rendered WAVs. Everything is testable without Ableton running.

**Tech Stack:** Python 3.12 (via `uv`), stdlib `gzip` + `xml.etree.ElementTree`, `ruamel.yaml` (round-trip preserving), `numpy`, `soundfile`, `pyloudnorm`, `pytest`.

**Spec:** `docs/superpowers/specs/2026-10-09-stem-export-design.md`

## Scope

This plan delivers **the offline core only** — spec §2, §4, §6, §7, §8, plus the planning half of §5. It is independently useful: it validates a mapping, prints the exact exclusion set per pass, and does all post-render work.

Explicitly **deferred to follow-on plans**, both named as seams here:
- **Live bridge** (spec §3 *Live bridge*, §5 steps 4–6, §11 V3) — applying exclusion state and bypassing Master devices. Until it exists, the CLI prints the mute list and you apply it by hand.
- **Mapping UI** (spec §3 *Mapping UI*) — mocked in `.context/mockup/`. The CLI edits the manifest for now.

## Global Constraints

- **The tool never writes a `.als`.** Every `.als` file handle is opened `"rb"`. No code path writes, truncates, or renames a `.als`. (spec §1, §3)
- Python `>=3.12,<3.13` — pinned because `soundfile`/`pyloudnorm` wheels are unreliable on 3.14, which is the system default here.
- Stems are a **strict partition**: every audible track belongs to exactly one stem. (spec §2)
- `Backing` is **computed**, never enumerated — every audible track no other stem claims. (spec §4)
- Extras overlap freely and sit outside the null sum. (spec §2, §8)
- Audible = not a group track, not a return track, not muted in the project. (spec §5)
- Output layout: `<stems_root>/<song>/<song> (<stem>)<suffix>.wav` and `<stems_root>/<song>/Extras/<song> (<extra>).wav` (spec §4)
- Level: **one gain per song applied to every stem and extra**; true-peak ceiling `-6.0 dBFS`; default target `-18.0 LUFS`. (spec §7)
- Null residual threshold: `-60.0 dBFS`. (spec §8)

## Review Focus

Five input classes the spec implies but no task's happy-path tests exercise. Each has its test pinned to the task that owns the code.

1. **Duplicate track names.** `Learning to Feel.als` really contains two tracks named `Acid V MIDI` and two named `Chem Bros 3`. Name-based manifest resolution is ambiguous for these; it must resolve by stable `Id` and report ambiguity rather than silently binding the first match. → Task 4.
2. **Uncompressed `.als`.** Live can write plain XML. The reader must sniff the gzip magic bytes rather than assume compression, or it crashes on a valid project. → Task 1.
3. **Stale track reference in the manifest.** A track deleted or re-added since the manifest was written. Must surface as a finding naming the track, not a `KeyError`. → Task 4.
4. **Mismatched renders when summing.** Different lengths, sample rates, or channel counts across rendered stems. Must fail loudly; silently zero-padding or truncating produces a null test that passes for the wrong reason. → Task 7.
5. **Unsafe characters in song or stem names.** `/` in a song name must not escape the destination directory, and the empty-name case must not produce a dotfile. → Task 8.

---

### Task 1: Scaffold, model, and the `.als` track-tree reader

**Files:**
- Create: `pyproject.toml`
- Create: `src/stemkit/__init__.py`
- Create: `src/stemkit/model.py`
- Create: `src/stemkit/als.py`
- Create: `tests/conftest.py`
- Test: `tests/test_als.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `model.Track`, `model.MasterDevice`, `model.Project`, `als.read_project(path: Path) -> Project`.
  - `Track(id: int, name: str, kind: str, group_id: int | None, muted: bool, devices: tuple[str, ...], taps: tuple[SidechainTap, ...])` where `kind` is one of `"audio" | "midi" | "group" | "return"`.
  - `Project.tracks: tuple[Track, ...]`, `Project.name: str`, `Project.path: Path`, `Project.master_devices: tuple[MasterDevice, ...]`.
  - `Project.by_id: dict[int, Track]`, `Project.children(tid) -> tuple[Track, ...]`, `Project.descendants(tid) -> tuple[Track, ...]`, `Project.ancestors(tid) -> tuple[Track, ...]`, `Project.audible() -> tuple[Track, ...]`, `Project.depth(tid) -> int`.
  - Task 2 fills `devices`, `taps`, and `master_devices`; Task 1 leaves them empty tuples.

- [ ] **Step 1: Create the project scaffold**

```bash
cd "$(git rev-parse --show-toplevel)"
uv init --package --name stemkit --python 3.12 .
uv add --dev pytest
```

Then set `requires-python = ">=3.12,<3.13"` in `pyproject.toml` and add:

```toml
[tool.pytest.ini_options]
testpaths = ["tests"]
```

- [ ] **Step 2: Write the fixture builder**

Create `tests/conftest.py`. This emits the minimal `.als` XML subset the reader needs, so tests are fast and don't depend on a 46 MB real project.

```python
import gzip
from pathlib import Path
import pytest

def _track_xml(tid, tag, name, group_id=-1, muted=False, body=""):
    return f"""<{tag} Id="{tid}">
  <Name><EffectiveName Value="{name}" /></Name>
  <TrackGroupId Value="{group_id}" />
  <DeviceChain>
    <Mixer><Speaker><Manual Value="{'false' if muted else 'true'}" /></Speaker></Mixer>
    <DeviceChain><Devices>{body}</Devices></DeviceChain>
  </DeviceChain>
</{tag}>"""

def build_als(tracks, master_devices="", compressed=True):
    """tracks: list of pre-rendered track XML strings."""
    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Ableton MajorVersion="5" MinorVersion="12.0_12402" Creator="Ableton Live 12.4.3">
  <LiveSet>
    <Tracks>{''.join(tracks)}</Tracks>
    <MasterTrack><DeviceChain><DeviceChain><Devices>{master_devices}</Devices>
      </DeviceChain></DeviceChain></MasterTrack>
  </LiveSet>
</Ableton>"""
    data = xml.encode("utf-8")
    return gzip.compress(data) if compressed else data

@pytest.fixture
def simple_als(tmp_path):
    """Group 'Drums' containing 'Kick' and a muted 'Snare', plus a top-level 'Bass'."""
    tracks = [
        _track_xml(1, "GroupTrack", "Drums"),
        _track_xml(2, "MidiTrack", "Kick", group_id=1),
        _track_xml(3, "MidiTrack", "Snare", group_id=1, muted=True),
        _track_xml(4, "AudioTrack", "Bass"),
        _track_xml(5, "ReturnTrack", "A-Reverb"),
    ]
    p = tmp_path / "Song.als"
    p.write_bytes(build_als(tracks))
    return p
```

- [ ] **Step 3: Write the failing tests**

Create `tests/test_als.py`:

```python
from pathlib import Path
from stemkit.als import read_project
from tests.conftest import build_als, _track_xml

def test_reads_tracks_and_kinds(simple_als):
    p = read_project(simple_als)
    assert p.name == "Song"
    assert [t.name for t in p.tracks] == ["Drums", "Kick", "Snare", "Bass", "A-Reverb"]
    assert [t.kind for t in p.tracks] == ["group", "midi", "midi", "audio", "return"]

def test_reads_group_structure(simple_als):
    p = read_project(simple_als)
    assert p.by_id[2].group_id == 1
    assert p.by_id[4].group_id is None
    assert [t.name for t in p.children(1)] == ["Kick", "Snare"]
    assert [t.name for t in p.ancestors(2)] == ["Drums"]
    assert p.depth(2) == 1 and p.depth(4) == 0

def test_audible_excludes_groups_returns_and_muted(simple_als):
    p = read_project(simple_als)
    assert [t.name for t in p.audible()] == ["Kick", "Bass"]

def test_reads_uncompressed_als(tmp_path):
    """Review Focus 2: Live can write plain XML, not just gzip."""
    p = tmp_path / "Plain.als"
    p.write_bytes(build_als([_track_xml(1, "AudioTrack", "Solo Track")], compressed=False))
    assert [t.name for t in read_project(p).tracks] == ["Solo Track"]

def test_never_opens_als_for_writing(simple_als, monkeypatch):
    """Global constraint: the tool never writes a .als."""
    import builtins
    real_open = builtins.open
    def guard(file, mode="r", *a, **k):
        if str(file).endswith(".als") and ("w" in mode or "a" in mode or "+" in mode):
            raise AssertionError(f"opened .als for writing: {file} mode={mode}")
        return real_open(file, mode, *a, **k)
    monkeypatch.setattr(builtins, "open", guard)
    read_project(simple_als)
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `uv run pytest tests/test_als.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'stemkit.als'`

- [ ] **Step 5: Write the model**

Create `src/stemkit/model.py`:

```python
from __future__ import annotations
from dataclasses import dataclass, field
from pathlib import Path

AUDIBLE_KINDS = frozenset({"audio", "midi"})

@dataclass(frozen=True)
class SidechainTap:
    key_track_id: int
    key_track_name: str
    tap: str  # "Pre FX" | "Post FX" | "Post Mixer"

@dataclass(frozen=True)
class MasterDevice:
    name: str
    enabled: bool

@dataclass(frozen=True)
class Track:
    id: int
    name: str
    kind: str
    group_id: int | None
    muted: bool
    devices: tuple[str, ...] = ()
    taps: tuple[SidechainTap, ...] = ()

@dataclass(frozen=True)
class Project:
    path: Path
    name: str
    tracks: tuple[Track, ...]
    master_devices: tuple[MasterDevice, ...] = ()
    by_id: dict[int, Track] = field(init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "by_id", {t.id: t for t in self.tracks})

    def children(self, tid: int) -> tuple[Track, ...]:
        return tuple(t for t in self.tracks if t.group_id == tid)

    def descendants(self, tid: int) -> tuple[Track, ...]:
        out: list[Track] = []
        for child in self.children(tid):
            out.append(child)
            out.extend(self.descendants(child.id))
        return tuple(out)

    def ancestors(self, tid: int) -> tuple[Track, ...]:
        out: list[Track] = []
        cur = self.by_id[tid].group_id
        while cur is not None:
            out.append(self.by_id[cur])
            cur = self.by_id[cur].group_id
        return tuple(out)

    def depth(self, tid: int) -> int:
        return len(self.ancestors(tid))

    def audible(self) -> tuple[Track, ...]:
        return tuple(t for t in self.tracks if t.kind in AUDIBLE_KINDS and not t.muted)
```

- [ ] **Step 6: Write the reader**

Create `src/stemkit/als.py`:

```python
from __future__ import annotations
import gzip
import xml.etree.ElementTree as ET
from pathlib import Path

from stemkit.model import Project, Track

_GZIP_MAGIC = b"\x1f\x8b"

_KIND_BY_TAG = {
    "AudioTrack": "audio",
    "MidiTrack": "midi",
    "GroupTrack": "group",
    "ReturnTrack": "return",
}

def read_bytes(path: Path) -> bytes:
    """Read a .als as raw XML, transparently handling gzip or plain XML."""
    raw = Path(path).read_bytes()
    return gzip.decompress(raw) if raw[:2] == _GZIP_MAGIC else raw

def _text(el: ET.Element | None, default: str = "") -> str:
    return default if el is None else (el.get("Value") or default)

def read_project(path: Path) -> Project:
    path = Path(path)
    root = ET.fromstring(read_bytes(path))
    live_set = root.find("LiveSet")
    if live_set is None:
        raise ValueError(f"{path}: no <LiveSet> element — not an Ableton set?")

    tracks: list[Track] = []
    for el in live_set.find("Tracks") or []:
        kind = _KIND_BY_TAG.get(el.tag)
        if kind is None:
            continue
        gid = int(_text(el.find("TrackGroupId"), "-1"))
        speaker = _text(el.find("DeviceChain/Mixer/Speaker/Manual"), "true")
        tracks.append(Track(
            id=int(el.get("Id", "-1")),
            name=_text(el.find("Name/EffectiveName")),
            kind=kind,
            group_id=None if gid == -1 else gid,
            muted=(speaker == "false"),
        ))

    return Project(path=path, name=path.stem, tracks=tuple(tracks))
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `uv run pytest tests/test_als.py -v`
Expected: 5 passed

- [ ] **Step 8: Commit**

```bash
git add pyproject.toml uv.lock src/stemkit tests
git commit -m "feat: .als track-tree reader with immutable Project model"
```

---

### Task 2: Reader — devices, sidechain taps, and Master state

**Files:**
- Modify: `src/stemkit/als.py`
- Modify: `tests/conftest.py`
- Test: `tests/test_als_devices.py`

**Interfaces:**
- Consumes: `model.Track`, `model.SidechainTap`, `model.MasterDevice`, `als.read_project` (Task 1).
- Produces: populated `Track.devices: tuple[str, ...]`, `Track.taps: tuple[SidechainTap, ...]`, `Project.master_devices: tuple[MasterDevice, ...]`. Also `als.PRE_MIXER_TAPS: frozenset[str]` = `{"Pre FX", "Post FX"}` — Task 5 and Task 6 both depend on this set.

- [ ] **Step 1: Extend the fixture builder**

Append to `tests/conftest.py`:

```python
def device_xml(tag="PluginDevice", name=None, enabled=True, sidechain=None):
    """sidechain: (key_track_id, key_track_name, tap) or None."""
    label = f'<UserName Value="{name}" />' if name else ""
    sc = ""
    if sidechain:
        kid, kname, tap = sidechain
        slug = {"Pre FX": "PreFxOut", "Post FX": "PostFxOut", "Post Mixer": "TrackOut"}[tap]
        sc = f"""<InRoutings><Routing>
          <Target Value="AudioIn/Track.{kid}/{slug}" />
          <UpperDisplayString Value="{kname}" />
          <LowerDisplayString Value="{tap}" />
        </Routing></InRoutings>"""
    return (f'<{tag}>{label}<On><Manual Value="{str(enabled).lower()}" /></On>{sc}</{tag}>')

@pytest.fixture
def ducked_als(tmp_path):
    """'Bass' group ducked from 'Kick' via a Post Mixer tap; Master has one live device."""
    tracks = [
        _track_xml(1, "MidiTrack", "Kick"),
        _track_xml(2, "GroupTrack", "Bass",
                   body=device_xml("MxDeviceAudioEffect", "GMaudio Ducker 1.5",
                                   sidechain=(1, "Kick", "Post Mixer"))),
        _track_xml(3, "AudioTrack", "Sub", group_id=2,
                   body=device_xml("PluginDevice", "Serum",
                                   sidechain=(1, "Kick", "Post FX"))),
    ]
    p = tmp_path / "Ducked.als"
    p.write_bytes(build_als(tracks, master_devices=device_xml("Limiter", "Limiter")))
    return p
```

- [ ] **Step 2: Write the failing tests**

Create `tests/test_als_devices.py`:

```python
from stemkit.als import read_project, PRE_MIXER_TAPS

def test_reads_device_names(ducked_als):
    p = read_project(ducked_als)
    assert p.by_id[2].devices == ("GMaudio Ducker 1.5",)
    assert p.by_id[3].devices == ("Serum",)
    assert p.by_id[1].devices == ()

def test_reads_sidechain_taps(ducked_als):
    p = read_project(ducked_als)
    tap = p.by_id[2].taps[0]
    assert (tap.key_track_id, tap.key_track_name, tap.tap) == (1, "Kick", "Post Mixer")
    assert p.by_id[3].taps[0].tap == "Post FX"

def test_pre_mixer_taps_classification():
    assert PRE_MIXER_TAPS == frozenset({"Pre FX", "Post FX"})
    assert "Post Mixer" not in PRE_MIXER_TAPS

def test_reads_master_devices(ducked_als):
    p = read_project(ducked_als)
    assert [(d.name, d.enabled) for d in p.master_devices] == [("Limiter", True)]

def test_master_empty_when_no_devices(simple_als):
    assert read_project(simple_als).master_devices == ()
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `uv run pytest tests/test_als_devices.py -v`
Expected: FAIL with `ImportError: cannot import name 'PRE_MIXER_TAPS'`

- [ ] **Step 4: Implement device and tap extraction**

In `src/stemkit/als.py`, add after `_KIND_BY_TAG`:

```python
PRE_MIXER_TAPS = frozenset({"Pre FX", "Post FX"})

_DEVICE_TAGS = {"PluginDevice", "AudioEffectGroupDevice", "MxDeviceAudioEffect"}

_FALLBACK_LABEL = {
    "PluginDevice": "VST",
    "AudioEffectGroupDevice": "Rack",
    "MxDeviceAudioEffect": "M4L",
}

def _device_label(el: ET.Element) -> str:
    for xp in ("./UserName", ".//FileRef/Name", ".//PlugName"):
        found = el.find(xp)
        if found is not None and found.get("Value"):
            stem = found.get("Value", "").split("/")[-1]
            for ext in (".adg", ".amxd", ".adv"):
                stem = stem.removesuffix(ext)
            return stem
    return _FALLBACK_LABEL.get(el.tag, el.tag)

def _devices(track_el: ET.Element) -> tuple[str, ...]:
    chain = track_el.find("DeviceChain/DeviceChain/Devices")
    if chain is None:
        return ()
    return tuple(_device_label(d) for d in chain)

def _taps(track_el: ET.Element) -> tuple[SidechainTap, ...]:
    out: list[SidechainTap] = []
    for routing in track_el.iter("Routing"):
        target = _text(routing.find("Target"))
        if not target.startswith("AudioIn/Track."):
            continue
        try:
            key_id = int(target.split("AudioIn/Track.", 1)[1].split("/", 1)[0])
        except (IndexError, ValueError):
            continue
        out.append(SidechainTap(
            key_track_id=key_id,
            key_track_name=_text(routing.find("UpperDisplayString")),
            tap=_text(routing.find("LowerDisplayString")),
        ))
    return tuple(out)

def _master_devices(live_set: ET.Element) -> tuple[MasterDevice, ...]:
    chain = live_set.find("MasterTrack/DeviceChain/DeviceChain/Devices")
    if chain is None:
        return ()
    return tuple(
        MasterDevice(name=_device_label(d), enabled=_text(d.find("On/Manual"), "true") == "true")
        for d in chain
    )
```

Update the import line to `from stemkit.model import MasterDevice, Project, SidechainTap, Track`,
pass `devices=_devices(el), taps=_taps(el)` into the `Track(...)` call, and pass
`master_devices=_master_devices(live_set)` into the `Project(...)` call.

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv run pytest tests/ -v`
Expected: 10 passed

- [ ] **Step 6: Verify against the real project**

Run:

```bash
uv run python -c "
from stemkit.als import read_project
p = read_project('/Users/stephenkaplan/Documents/Ableton/Project Files/Releases (May 2014 - Present)/Learning to Feel EP/Learning to Feel Project/Learning to Feel.als')
print(len(p.tracks), 'tracks;', len(p.audible()), 'audible')
print('master:', p.master_devices)
for t in p.tracks:
    for tap in t.taps:
        print(f'  {t.name[:30]:30} <- {tap.key_track_name} ({tap.tap})')
"
```

Expected: 73 tracks (excluding returns the count is higher — returns are included here), `master: ()`, and 15 taps of which exactly one is `Post Mixer` (on `Bass`, keyed from `Kick`).

- [ ] **Step 7: Commit**

```bash
git add src/stemkit tests
git commit -m "feat: read device chains, sidechain taps, and Master device state"
```

---

### Task 3: Registry

**Files:**
- Create: `src/stemkit/registry.py`
- Create: `registry.yaml`
- Test: `tests/test_registry.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `registry.Registry`, `registry.load_registry(path: Path) -> Registry`.
  - `Registry.stem_names() -> frozenset[str]` — every legal stem name (fixed stems plus every instrument×variant).
  - `Registry.is_known(name: str) -> bool`
  - `Registry.suggest(name: str) -> str | None` — nearest legal name within edit distance, else `None`.
  - `Registry.stems_root: Path`, `Registry.instrument_slots_per_deck: int`.
  - `Registry.instrument_of(stem: str) -> str | None` — the instrument a stem belongs to, for the slot-count check in Task 5.

- [ ] **Step 1: Write the registry file**

Create `registry.yaml` at the repo root, seeded from `Live Set (Columbus - Arturia)` plus the stem-frequency data in spec §2:

```yaml
instruments:
  - { name: Guitar,       variants: [Played, Backing] }
  - { name: Sub37,        variants: [Played ONLY SUB, Played Rev2-able, Backing] }
  - { name: Rev2,         variants: [Played, Backing] }
  - { name: Organ,        variants: [Played, Backing] }
  - { name: Rhodes,       variants: [Played, Backing] }
  - { name: Clavinet,     variants: [Played, Backing] }
  - { name: Pianet,       variants: [Played, Backing] }
  - { name: Piano,        variants: [Played, Backing] }
  - { name: Keys,         variants: [Played, Backing] }
  - { name: Arturia,      variants: [Played, Backing] }
  - { name: Serum,        variants: [Played, Backing] }
  - { name: Vibes,        variants: [Played, Backing] }
  - { name: Talkbox,      variants: [Played, Backing] }
  - { name: Vocals,       variants: [Played, Backing] }
  - { name: Samples,      variants: [Played, Backing] }

fixed_stems: [Drums, Vocals, Samples, Vocal Samples, Backing]

live_set:
  instrument_slots_per_deck: 8
  decks: 2

output:
  stems_root: "~/Documents/Ableton/Project Files/Live Sets/Live Sets (8-track)/Content/Stems"
  extras_dir: Extras
```

- [ ] **Step 2: Add the YAML dependency**

```bash
uv add ruamel.yaml
```

- [ ] **Step 3: Write the failing tests**

Create `tests/test_registry.py`:

```python
import pytest
from pathlib import Path
from stemkit.registry import load_registry

@pytest.fixture
def reg():
    return load_registry(Path("registry.yaml"))

def test_expands_instrument_variants(reg):
    names = reg.stem_names()
    assert "Sub37 - Played Rev2-able" in names
    assert "Rhodes - Backing" in names
    assert "Clavinet - Played" in names

def test_includes_fixed_stems(reg):
    assert {"Drums", "Backing", "Vocal Samples"} <= reg.stem_names()

def test_rejects_unknown_names(reg):
    assert reg.is_known("Organ - Backing")
    assert not reg.is_known("Organ - Playedl")
    assert not reg.is_known("Sub37- Played")

def test_suggests_nearest_for_real_typos(reg):
    assert reg.suggest("Organ - Playedl") == "Organ - Played"
    assert reg.suggest("Sub37- Played") == "Sub37 - Played"
    assert reg.suggest("Rhods - Backing") == "Rhodes - Backing"

def test_suggest_returns_none_when_nothing_is_close(reg):
    assert reg.suggest("Didgeridoo Orchestra") is None

def test_instrument_of(reg):
    assert reg.instrument_of("Rhodes - Backing") == "Rhodes"
    assert reg.instrument_of("Sub37 - Played ONLY SUB") == "Sub37"
    assert reg.instrument_of("Drums") is None
    assert reg.instrument_of("Backing") is None

def test_stems_root_is_expanded(reg):
    assert reg.stems_root.is_absolute()
    assert "~" not in str(reg.stems_root)
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `uv run pytest tests/test_registry.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'stemkit.registry'`

- [ ] **Step 5: Implement the registry**

Create `src/stemkit/registry.py`:

```python
from __future__ import annotations
import difflib
from dataclasses import dataclass
from pathlib import Path

from ruamel.yaml import YAML

@dataclass(frozen=True)
class Instrument:
    name: str
    variants: tuple[str, ...]

@dataclass(frozen=True)
class Registry:
    instruments: tuple[Instrument, ...]
    fixed_stems: tuple[str, ...]
    instrument_slots_per_deck: int
    stems_root: Path
    extras_dir: str

    def stem_names(self) -> frozenset[str]:
        names = set(self.fixed_stems)
        for inst in self.instruments:
            names.update(f"{inst.name} - {v}" for v in inst.variants)
        return frozenset(names)

    def is_known(self, name: str) -> bool:
        return name in self.stem_names()

    def suggest(self, name: str) -> str | None:
        hits = difflib.get_close_matches(name, sorted(self.stem_names()), n=1, cutoff=0.8)
        return hits[0] if hits else None

    def instrument_of(self, stem: str) -> str | None:
        for inst in self.instruments:
            if any(stem == f"{inst.name} - {v}" for v in inst.variants):
                return inst.name
        return None

def load_registry(path: Path) -> Registry:
    raw = YAML(typ="safe").load(Path(path).read_text())
    out = raw.get("output", {})
    return Registry(
        instruments=tuple(
            Instrument(name=i["name"], variants=tuple(i["variants"]))
            for i in raw.get("instruments", [])
        ),
        fixed_stems=tuple(raw.get("fixed_stems", [])),
        instrument_slots_per_deck=int(raw.get("live_set", {}).get("instrument_slots_per_deck", 8)),
        stems_root=Path(out.get("stems_root", ".")).expanduser(),
        extras_dir=out.get("extras_dir", "Extras"),
    )
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `uv run pytest tests/test_registry.py -v`
Expected: 7 passed

- [ ] **Step 7: Commit**

```bash
git add registry.yaml src/stemkit/registry.py tests/test_registry.py pyproject.toml uv.lock
git commit -m "feat: stem name registry with typo suggestions"
```

---

### Task 4: Manifest and track resolution

**Files:**
- Create: `src/stemkit/manifest.py`
- Test: `tests/test_manifest.py`

**Interfaces:**
- Consumes: `model.Project` (Task 1).
- Produces:
  - `manifest.TrackRef(id: int | None, name: str)`
  - `manifest.StemSpec(tracks: list[TrackRef], suffix: str = "", computed: bool = False)`
  - `manifest.ExtraSpec(name: str, tracks: list[TrackRef])`
  - `manifest.Manifest(song, als, target_lufs, true_peak_ceiling_db, applied_gain_db, stems: dict[str, StemSpec], extras: list[ExtraSpec])`
  - `manifest.load_manifest(path) -> Manifest`, `manifest.save_manifest(m, path) -> None`
  - `manifest.manifest_path_for(als_path: Path) -> Path` — `<als dir>/stems.yaml`
  - `manifest.Resolution(assigned: dict[int, str], backing: tuple[int, ...], unresolved: tuple[str, ...], ambiguous: tuple[str, ...], double_claimed: tuple[int, ...])`
  - `manifest.resolve(m: Manifest, p: Project) -> Resolution`

  `resolve` binds by `TrackRef.id` first; falls back to name only when the name matches exactly one track. A name matching several tracks goes to `ambiguous`; a ref matching none goes to `unresolved`. Every audible track not in `assigned` lands in `backing`. A track claimed by two stems goes to `double_claimed` — Task 5 turns that into an error.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_manifest.py`:

```python
import pytest
from pathlib import Path
from stemkit.als import read_project
from stemkit.manifest import (ExtraSpec, Manifest, StemSpec, TrackRef,
                              load_manifest, manifest_path_for, resolve, save_manifest)
from tests.conftest import _track_xml, build_als

def _m(stems, extras=()):
    return Manifest(song="Song", als="Song.als", target_lufs=-18.0,
                    true_peak_ceiling_db=-6.0, applied_gain_db=None,
                    stems=stems, extras=list(extras))

def test_round_trips_through_yaml(tmp_path):
    m = _m({"Drums": StemSpec(tracks=[TrackRef(2, "Kick")]),
            "Arturia - Played": StemSpec(tracks=[TrackRef(4, "Womp")], suffix=" Jup Sync Lead"),
            "Backing": StemSpec(tracks=[], computed=True)},
           [ExtraSpec("Kick & Snare", [TrackRef(2, "Kick"), TrackRef(3, "Snare")])])
    p = tmp_path / "stems.yaml"
    save_manifest(m, p)
    back = load_manifest(p)
    assert back.stems["Arturia - Played"].suffix == " Jup Sync Lead"
    assert back.stems["Backing"].computed is True
    assert [t.name for t in back.extras[0].tracks] == ["Kick", "Snare"]
    assert back.target_lufs == -18.0

def test_manifest_path_sits_beside_the_als(tmp_path):
    assert manifest_path_for(tmp_path / "A" / "Song.als") == tmp_path / "A" / "stems.yaml"

def test_backing_is_computed_not_enumerated(simple_als):
    p = read_project(simple_als)          # audible: Kick(2), Bass(4)
    r = resolve(_m({"Drums": StemSpec(tracks=[TrackRef(2, "Kick")])}), p)
    assert r.assigned == {2: "Drums"}
    assert r.backing == (4,)

def test_resolves_by_id_when_names_collide(tmp_path):
    """Review Focus 1: Learning to Feel really has two tracks named 'Acid V MIDI'."""
    als = tmp_path / "Dupes.als"
    als.write_bytes(build_als([_track_xml(7, "MidiTrack", "Acid V MIDI"),
                               _track_xml(8, "MidiTrack", "Acid V MIDI")]))
    p = read_project(als)
    r = resolve(_m({"Arturia - Backing": StemSpec(tracks=[TrackRef(8, "Acid V MIDI")])}), p)
    assert r.assigned == {8: "Arturia - Backing"}
    assert r.backing == (7,)
    assert r.ambiguous == ()

def test_name_only_ref_is_ambiguous_when_names_collide(tmp_path):
    """Review Focus 1: a name-only ref must not silently bind the first match."""
    als = tmp_path / "Dupes.als"
    als.write_bytes(build_als([_track_xml(7, "MidiTrack", "Acid V MIDI"),
                               _track_xml(8, "MidiTrack", "Acid V MIDI")]))
    p = read_project(als)
    r = resolve(_m({"Arturia - Backing": StemSpec(tracks=[TrackRef(None, "Acid V MIDI")])}), p)
    assert r.ambiguous == ("Acid V MIDI",)
    assert r.assigned == {}

def test_stale_reference_is_reported_not_raised(simple_als):
    """Review Focus 3: a track deleted since the manifest was written."""
    p = read_project(simple_als)
    r = resolve(_m({"Drums": StemSpec(tracks=[TrackRef(999, "Ghost Track")])}), p)
    assert r.unresolved == ("Ghost Track",)
    assert r.assigned == {}

def test_falls_back_to_name_when_id_is_stale_but_name_is_unique(simple_als):
    p = read_project(simple_als)
    r = resolve(_m({"Drums": StemSpec(tracks=[TrackRef(999, "Kick")])}), p)
    assert r.assigned == {2: "Drums"}
    assert r.unresolved == ()

def test_double_claimed_track_is_flagged(simple_als):
    p = read_project(simple_als)
    r = resolve(_m({"Drums": StemSpec(tracks=[TrackRef(2, "Kick")]),
                    "Serum - Backing": StemSpec(tracks=[TrackRef(2, "Kick")])}), p)
    assert r.double_claimed == (2,)

def test_muted_tracks_never_reach_backing(simple_als):
    p = read_project(simple_als)          # Snare(3) is muted
    r = resolve(_m({}), p)
    assert 3 not in r.backing
    assert set(r.backing) == {2, 4}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_manifest.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'stemkit.manifest'`

- [ ] **Step 3: Implement the manifest**

Create `src/stemkit/manifest.py`:

```python
from __future__ import annotations
import io
from dataclasses import dataclass, field
from pathlib import Path

from ruamel.yaml import YAML

from stemkit.model import Project

_yaml = YAML()
_yaml.default_flow_style = False

@dataclass(frozen=True)
class TrackRef:
    id: int | None
    name: str

@dataclass
class StemSpec:
    tracks: list[TrackRef] = field(default_factory=list)
    suffix: str = ""
    computed: bool = False

@dataclass
class ExtraSpec:
    name: str
    tracks: list[TrackRef] = field(default_factory=list)

@dataclass
class Manifest:
    song: str
    als: str
    target_lufs: float
    true_peak_ceiling_db: float
    applied_gain_db: float | None
    stems: dict[str, StemSpec]
    extras: list[ExtraSpec] = field(default_factory=list)

@dataclass(frozen=True)
class Resolution:
    assigned: dict[int, str]
    backing: tuple[int, ...]
    unresolved: tuple[str, ...]
    ambiguous: tuple[str, ...]
    double_claimed: tuple[int, ...]

def manifest_path_for(als_path: Path) -> Path:
    return Path(als_path).parent / "stems.yaml"

def _ref_to_yaml(r: TrackRef) -> dict:
    return {"id": r.id, "name": r.name}

def save_manifest(m: Manifest, path: Path) -> None:
    doc = {
        "song": m.song,
        "als": m.als,
        "level": {
            "target_lufs": m.target_lufs,
            "true_peak_ceiling_db": m.true_peak_ceiling_db,
            "applied_gain_db": m.applied_gain_db,
        },
        "stems": {
            name: ({"computed": True} if s.computed else
                   {"tracks": [_ref_to_yaml(t) for t in s.tracks]}
                   | ({"suffix": s.suffix} if s.suffix else {}))
            for name, s in m.stems.items()
        },
        "extras": [{"name": e.name, "tracks": [_ref_to_yaml(t) for t in e.tracks]}
                   for e in m.extras],
    }
    buf = io.StringIO()
    _yaml.dump(doc, buf)
    Path(path).write_text(buf.getvalue())

def load_manifest(path: Path) -> Manifest:
    doc = _yaml.load(Path(path).read_text())
    lvl = doc.get("level", {})
    refs = lambda lst: [TrackRef(t.get("id"), t["name"]) for t in (lst or [])]
    return Manifest(
        song=doc["song"],
        als=doc["als"],
        target_lufs=float(lvl.get("target_lufs", -18.0)),
        true_peak_ceiling_db=float(lvl.get("true_peak_ceiling_db", -6.0)),
        applied_gain_db=(None if lvl.get("applied_gain_db") is None
                         else float(lvl["applied_gain_db"])),
        stems={n: StemSpec(tracks=refs(s.get("tracks")), suffix=s.get("suffix", ""),
                           computed=bool(s.get("computed", False)))
               for n, s in (doc.get("stems") or {}).items()},
        extras=[ExtraSpec(e["name"], refs(e.get("tracks"))) for e in (doc.get("extras") or [])],
    )

def _bind(ref: TrackRef, project: Project) -> tuple[int | None, str | None]:
    """Return (track_id, problem). problem is 'unresolved' | 'ambiguous' | None."""
    if ref.id is not None and ref.id in project.by_id:
        return ref.id, None
    matches = [t for t in project.tracks if t.name == ref.name]
    if len(matches) == 1:
        return matches[0].id, None
    return None, ("ambiguous" if len(matches) > 1 else "unresolved")

def resolve(m: Manifest, project: Project) -> Resolution:
    assigned: dict[int, str] = {}
    double: list[int] = []
    unresolved: list[str] = []
    ambiguous: list[str] = []

    for stem_name, spec in m.stems.items():
        if spec.computed:
            continue
        for ref in spec.tracks:
            tid, problem = _bind(ref, project)
            if problem == "unresolved":
                unresolved.append(ref.name)
            elif problem == "ambiguous":
                ambiguous.append(ref.name)
            elif tid in assigned and assigned[tid] != stem_name:
                double.append(tid)
            else:
                assigned[tid] = stem_name

    audible_ids = [t.id for t in project.audible()]
    return Resolution(
        assigned={k: v for k, v in assigned.items() if k in set(audible_ids)},
        backing=tuple(i for i in audible_ids if i not in assigned),
        unresolved=tuple(dict.fromkeys(unresolved)),
        ambiguous=tuple(dict.fromkeys(ambiguous)),
        double_claimed=tuple(dict.fromkeys(double)),
    )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_manifest.py -v`
Expected: 9 passed

- [ ] **Step 5: Commit**

```bash
git add src/stemkit/manifest.py tests/test_manifest.py
git commit -m "feat: manifest persistence and track resolution with computed Backing"
```

---

### Task 5: Validator

**Files:**
- Create: `src/stemkit/validate.py`
- Test: `tests/test_validate.py`

**Interfaces:**
- Consumes: `model.Project`, `als.PRE_MIXER_TAPS`, `manifest.Manifest`, `manifest.Resolution`, `registry.Registry`.
- Produces: `validate.Finding(severity, rule, title, detail)` where `severity` is `"error" | "warn" | "info" | "ok"`; `validate.validate(project, manifest, resolution, registry) -> tuple[Finding, ...]`; `validate.blocking(findings) -> tuple[Finding, ...]` returning only `severity == "error"`.

Rules implemented, matching spec §6 (`rule` string in brackets):

| severity | rule |
|---|---|
| error | `[empty-stem]` a stem resolves to no audible tracks |
| error | `[unknown-stem]` stem name not in the registry (with suggestion) |
| error | `[post-mixer-key]` a `Post Mixer` tap whose key source is excluded from some pass |
| error | `[master-live]` any enabled Master device |
| error | `[double-claimed]` a track claimed by two stems |
| error | `[unresolved-ref]` manifest references a track that no longer exists |
| error | `[ambiguous-ref]` name-only ref matching several tracks |
| warn | `[split-group]` a group with devices whose descendants span >1 stem |
| warn | `[slot-overflow]` more distinct instruments than `instrument_slots_per_deck` |
| warn | `[song-folder-mismatch]` an existing stems folder differs from `song` only by case or spacing |
| info | `[backing-fallthrough]` the list of tracks falling through to `Backing` |
| info | `[muted-held-out]` muted tracks, excluded from every stem |
| ok | `[master-clean]` no enabled Master devices |

- [ ] **Step 1: Write the failing tests**

Create `tests/test_validate.py`:

```python
import pytest
from pathlib import Path
from stemkit.als import read_project
from stemkit.manifest import Manifest, StemSpec, TrackRef, resolve
from stemkit.registry import load_registry
from stemkit.validate import blocking, validate
from tests.conftest import _track_xml, build_als, device_xml

@pytest.fixture
def reg():
    return load_registry(Path("registry.yaml"))

def _m(stems):
    return Manifest(song="Song", als="Song.als", target_lufs=-18.0,
                    true_peak_ceiling_db=-6.0, applied_gain_db=None, stems=stems, extras=[])

def _rules(findings, severity=None):
    return {f.rule for f in findings if severity is None or f.severity == severity}

def test_flags_enabled_master_device(ducked_als, reg):
    p = read_project(ducked_als)
    m = _m({"Drums": StemSpec(tracks=[TrackRef(1, "Kick")])})
    f = validate(p, m, resolve(m, p), reg)
    assert "master-live" in _rules(f, "error")

def test_passes_clean_master(simple_als, reg):
    p = read_project(simple_als)
    m = _m({"Drums": StemSpec(tracks=[TrackRef(2, "Kick")])})
    f = validate(p, m, resolve(m, p), reg)
    assert "master-clean" in _rules(f, "ok")
    assert "master-live" not in _rules(f, "error")

def test_flags_post_mixer_key_source(ducked_als, reg):
    """The real Bass->Kick Post Mixer tap: Kick is excluded when rendering other stems."""
    p = read_project(ducked_als)
    m = _m({"Drums": StemSpec(tracks=[TrackRef(1, "Kick")]),
            "Serum - Backing": StemSpec(tracks=[TrackRef(3, "Sub")])})
    f = validate(p, m, resolve(m, p), reg)
    hit = [x for x in f if x.rule == "post-mixer-key"]
    assert hit and hit[0].severity == "error"
    assert "Kick" in hit[0].detail

def test_pre_mixer_taps_are_not_flagged(tmp_path, reg):
    als = tmp_path / "Ok.als"
    als.write_bytes(build_als([
        _track_xml(1, "MidiTrack", "Kick"),
        _track_xml(2, "AudioTrack", "Sub",
                   body=device_xml("PluginDevice", "Comp", sidechain=(1, "Kick", "Post FX"))),
    ]))
    p = read_project(als)
    m = _m({"Drums": StemSpec(tracks=[TrackRef(1, "Kick")]),
            "Serum - Backing": StemSpec(tracks=[TrackRef(2, "Sub")])})
    assert "post-mixer-key" not in _rules(validate(p, m, resolve(m, p), reg), "error")

def test_flags_empty_stem(simple_als, reg):
    p = read_project(simple_als)
    m = _m({"Drums": StemSpec(tracks=[TrackRef(3, "Snare")])})  # Snare is muted
    assert "empty-stem" in _rules(validate(p, m, resolve(m, p), reg), "error")

def test_flags_unknown_stem_name_with_suggestion(simple_als, reg):
    p = read_project(simple_als)
    m = _m({"Organ - Playedl": StemSpec(tracks=[TrackRef(2, "Kick")])})
    hit = [x for x in validate(p, m, resolve(m, p), reg) if x.rule == "unknown-stem"]
    assert hit and "Organ - Played" in hit[0].detail

def test_warns_on_split_processed_group(tmp_path, reg):
    """Arps-with-GlueCompressor shape: one processed group feeding two stems."""
    als = tmp_path / "Split.als"
    als.write_bytes(build_als([
        _track_xml(1, "GroupTrack", "Arps", body=device_xml("GlueCompressor", "Glue")),
        _track_xml(2, "MidiTrack", "Acid", group_id=1),
        _track_xml(3, "MidiTrack", "Pluck", group_id=1),
    ]))
    p = read_project(als)
    m = _m({"Arturia - Backing": StemSpec(tracks=[TrackRef(2, "Acid")]),
            "Sub37 - Backing": StemSpec(tracks=[TrackRef(3, "Pluck")])})
    hit = [x for x in validate(p, m, resolve(m, p), reg) if x.rule == "split-group"]
    assert hit and hit[0].severity == "warn"
    assert "Arps" in hit[0].detail and "Glue" in hit[0].detail

def test_does_not_warn_when_group_is_wholly_one_stem(tmp_path, reg):
    als = tmp_path / "Whole.als"
    als.write_bytes(build_als([
        _track_xml(1, "GroupTrack", "Arps", body=device_xml("GlueCompressor", "Glue")),
        _track_xml(2, "MidiTrack", "Acid", group_id=1),
        _track_xml(3, "MidiTrack", "Pluck", group_id=1),
    ]))
    p = read_project(als)
    m = _m({"Arturia - Backing": StemSpec(tracks=[TrackRef(2, "Acid"), TrackRef(3, "Pluck")])})
    assert "split-group" not in _rules(validate(p, m, resolve(m, p), reg), "warn")

def test_reports_backing_fallthrough(simple_als, reg):
    p = read_project(simple_als)
    m = _m({"Drums": StemSpec(tracks=[TrackRef(2, "Kick")])})
    hit = [x for x in validate(p, m, resolve(m, p), reg) if x.rule == "backing-fallthrough"]
    assert hit and "Bass" in hit[0].detail

def test_warns_on_song_folder_case_mismatch(simple_als, reg, tmp_path):
    """Real drift: 'Surrounded by Love' vs 'Surrounded By Love'."""
    import dataclasses
    (tmp_path / "Surrounded By Love").mkdir(parents=True)
    r2 = dataclasses.replace(reg, stems_root=tmp_path)
    p = read_project(simple_als)
    m = Manifest(song="Surrounded by Love", als="x.als", target_lufs=-18.0,
                 true_peak_ceiling_db=-6.0, applied_gain_db=None,
                 stems={"Drums": StemSpec(tracks=[TrackRef(2, "Kick")])}, extras=[])
    hit = [x for x in validate(p, m, resolve(m, p), r2) if x.rule == "song-folder-mismatch"]
    assert hit and "Surrounded By Love" in hit[0].detail

def test_no_folder_warning_when_names_match_exactly(simple_als, reg, tmp_path):
    import dataclasses
    (tmp_path / "Song").mkdir(parents=True)
    r2 = dataclasses.replace(reg, stems_root=tmp_path)
    p = read_project(simple_als)
    m = _m({"Drums": StemSpec(tracks=[TrackRef(2, "Kick")])})
    assert "song-folder-mismatch" not in _rules(validate(p, m, resolve(m, p), r2), "warn")

def test_reports_muted_tracks_held_out(simple_als, reg):
    p = read_project(simple_als)          # Snare(3) is muted
    m = _m({"Drums": StemSpec(tracks=[TrackRef(2, "Kick")])})
    hit = [x for x in validate(p, m, resolve(m, p), reg) if x.rule == "muted-held-out"]
    assert hit and "Snare" in hit[0].detail

def test_blocking_returns_only_errors(ducked_als, reg):
    p = read_project(ducked_als)
    m = _m({"Drums": StemSpec(tracks=[TrackRef(1, "Kick")])})
    assert all(f.severity == "error" for f in blocking(validate(p, m, resolve(m, p), reg)))
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_validate.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'stemkit.validate'`

- [ ] **Step 3: Implement the validator**

Create `src/stemkit/validate.py`:

```python
from __future__ import annotations
from dataclasses import dataclass

from stemkit.als import PRE_MIXER_TAPS
from stemkit.manifest import Manifest, Resolution
from stemkit.model import Project
from stemkit.registry import Registry

@dataclass(frozen=True)
class Finding:
    severity: str
    rule: str
    title: str
    detail: str

def blocking(findings: tuple[Finding, ...]) -> tuple[Finding, ...]:
    return tuple(f for f in findings if f.severity == "error")

def _stem_members(res: Resolution, stem: str) -> set[int]:
    if stem == "Backing":
        return set(res.backing)
    return {tid for tid, s in res.assigned.items() if s == stem}

def validate(project: Project, manifest: Manifest, res: Resolution,
             registry: Registry) -> tuple[Finding, ...]:
    out: list[Finding] = []
    stem_names = [n for n in manifest.stems] or ["Backing"]

    # --- Master state
    live = [d.name for d in project.master_devices if d.enabled]
    if live:
        out.append(Finding("error", "master-live", "Master devices are enabled",
                           f"Bypass these before exporting: {', '.join(live)}. "
                           "Stems must render premaster."))
    else:
        out.append(Finding("ok", "master-clean", "Master is clean",
                           "No enabled devices on the Master track."))

    # --- Reference integrity
    for name in res.unresolved:
        out.append(Finding("error", "unresolved-ref", "Manifest references a missing track",
                           f"'{name}' is in the manifest but not in the project."))
    for name in res.ambiguous:
        out.append(Finding("error", "ambiguous-ref", "Track name matches several tracks",
                           f"'{name}' matches more than one track; the manifest entry "
                           "needs a track id to disambiguate."))
    for tid in res.double_claimed:
        out.append(Finding("error", "double-claimed", "Track claimed by two stems",
                           f"'{project.by_id[tid].name}' is assigned more than once. "
                           "Stems must partition."))

    # --- Stem names and emptiness
    for stem in stem_names:
        if not registry.is_known(stem):
            hint = registry.suggest(stem)
            out.append(Finding("error", "unknown-stem", "Stem name not in registry",
                               f"'{stem}' is not a registry stem."
                               + (f" Did you mean '{hint}'?" if hint else "")))
        if not _stem_members(res, stem):
            out.append(Finding("error", "empty-stem", "Stem would render silent",
                               f"'{stem}' resolves to no audible tracks."))

    # --- Post Mixer keys whose source is excluded from some pass
    for track in project.tracks:
        for tap in track.taps:
            if tap.tap in PRE_MIXER_TAPS:
                continue
            key_stem = res.assigned.get(tap.key_track_id)
            key_in_backing = tap.key_track_id in res.backing
            for stem in stem_names:
                members = _stem_members(res, stem)
                key_present = (tap.key_track_id in members)
                if not key_present and (key_stem is not None or key_in_backing):
                    out.append(Finding(
                        "error", "post-mixer-key", "Sidechain key is excluded",
                        f"'{track.name}' ducks from '{tap.key_track_name}' tapped Post Mixer. "
                        f"Rendering '{stem}' excludes '{tap.key_track_name}', so that stem "
                        "loses its ducking. Switch the tap to Post FX and it is exact."))
                    break

    # --- Processed groups split across stems
    for group in (t for t in project.tracks if t.kind == "group" and t.devices):
        desc = [d.id for d in project.descendants(group.id) if d.kind in {"audio", "midi"}]
        spans = {res.assigned.get(d, "Backing") for d in desc
                 if d in res.assigned or d in res.backing}
        if len(spans) > 1:
            out.append(Finding("warn", "split-group", "Processed group split across stems",
                               f"'{group.name}' carries {', '.join(group.devices)} and splits "
                               f"across {', '.join(sorted(spans))}. Bus processing is applied "
                               "to the sum, so no single stem carries it."))

    # --- Live set slot budget
    insts = {registry.instrument_of(s) for s in stem_names}
    insts.discard(None)
    if len(insts) > registry.instrument_slots_per_deck:
        out.append(Finding("warn", "slot-overflow", "More instruments than live set slots",
                           f"{len(insts)} instruments into "
                           f"{registry.instrument_slots_per_deck} slots per deck."))

    # --- Song folder drift
    song_dir = registry.stems_root / manifest.song
    if registry.stems_root.is_dir() and not song_dir.is_dir():
        wanted = manifest.song.casefold().replace(" ", "")
        for existing in registry.stems_root.iterdir():
            if existing.is_dir() and existing.name.casefold().replace(" ", "") == wanted:
                out.append(Finding(
                    "warn", "song-folder-mismatch", "Song name differs from existing folder",
                    f"'{manifest.song}' would create a new folder, but "
                    f"'{existing.name}' already exists. Pick one spelling."))
                break

    # --- Muted tracks
    muted = [t.name for t in project.tracks
             if t.muted and t.kind in {"audio", "midi"}]
    if muted:
        out.append(Finding("info", "muted-held-out",
                           f"{len(muted)} muted tracks held out of every stem",
                           ", ".join(muted)))

    # --- Backing fall-through
    if res.backing:
        names = ", ".join(project.by_id[t].name for t in res.backing)
        out.append(Finding("info", "backing-fallthrough",
                           f"{len(res.backing)} tracks fall through to Backing",
                           f"{names}. Shown so it is a decision, not an accident."))

    return tuple(out)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_validate.py -v`
Expected: 13 passed

- [ ] **Step 5: Commit**

```bash
git add src/stemkit/validate.py tests/test_validate.py
git commit -m "feat: pre-flight validation rules"
```

---

### Task 6: Render planner

**Files:**
- Create: `src/stemkit/plan.py`
- Test: `tests/test_plan.py`

**Interfaces:**
- Consumes: `model.Project`, `als.PRE_MIXER_TAPS`, `manifest.Manifest`, `manifest.Resolution`, `registry.Registry`.
- Produces: `plan.Pass(kind, name, include, exclude, hold_keys, output_name)` where `kind` is `"stem" | "master" | "extra"`, `include`/`exclude`/`hold_keys` are `frozenset[int]` of track ids, and `output_name` is the final filename without directory. `plan.build_plan(project, manifest, resolution, registry) -> tuple[Pass, ...]`.

Order is stems (manifest order, `Backing` last), then the Master reference, then extras. `hold_keys` lists key-source tracks that are excluded from the pass but whose taps are pre-mixer, so the bridge knows to fade rather than mute them and the CLI can report it.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_plan.py`:

```python
import pytest
from pathlib import Path
from stemkit.als import read_project
from stemkit.manifest import ExtraSpec, Manifest, StemSpec, TrackRef, resolve
from stemkit.plan import build_plan
from stemkit.registry import load_registry
from tests.conftest import _track_xml, build_als, device_xml

@pytest.fixture
def reg():
    return load_registry(Path("registry.yaml"))

def _m(stems, extras=(), song="Song"):
    return Manifest(song=song, als="Song.als", target_lufs=-18.0,
                    true_peak_ceiling_db=-6.0, applied_gain_db=None,
                    stems=stems, extras=list(extras))

def test_pass_count_is_stems_plus_master_plus_extras(simple_als, reg):
    p = read_project(simple_als)
    m = _m({"Drums": StemSpec(tracks=[TrackRef(2, "Kick")]),
            "Backing": StemSpec(computed=True)},
           [ExtraSpec("Kick & Snare", [TrackRef(2, "Kick")])])
    passes = build_plan(p, m, resolve(m, p), reg)
    assert [x.kind for x in passes] == ["stem", "stem", "master", "extra"]

def test_exclusion_is_the_complement_of_inclusion(simple_als, reg):
    p = read_project(simple_als)          # audible: Kick(2), Bass(4)
    m = _m({"Drums": StemSpec(tracks=[TrackRef(2, "Kick")]), "Backing": StemSpec(computed=True)})
    drums = build_plan(p, m, resolve(m, p), reg)[0]
    assert drums.include == frozenset({2})
    assert drums.exclude == frozenset({4})

def test_master_pass_excludes_nothing(simple_als, reg):
    p = read_project(simple_als)
    m = _m({"Drums": StemSpec(tracks=[TrackRef(2, "Kick")]), "Backing": StemSpec(computed=True)})
    master = [x for x in build_plan(p, m, resolve(m, p), reg) if x.kind == "master"][0]
    assert master.exclude == frozenset()
    assert master.include == frozenset({2, 4})

def test_backing_pass_is_ordered_last_among_stems(simple_als, reg):
    p = read_project(simple_als)
    m = _m({"Backing": StemSpec(computed=True), "Drums": StemSpec(tracks=[TrackRef(2, "Kick")])})
    stems = [x.name for x in build_plan(p, m, resolve(m, p), reg) if x.kind == "stem"]
    assert stems == ["Drums", "Backing"]

def test_hold_keys_lists_excluded_pre_mixer_key_sources(tmp_path, reg):
    als = tmp_path / "Duck.als"
    als.write_bytes(build_als([
        _track_xml(1, "MidiTrack", "Kick"),
        _track_xml(2, "AudioTrack", "Sub",
                   body=device_xml("PluginDevice", "Comp", sidechain=(1, "Kick", "Post FX"))),
    ]))
    p = read_project(als)
    m = _m({"Serum - Backing": StemSpec(tracks=[TrackRef(2, "Sub")]),
            "Backing": StemSpec(computed=True)})
    sub = build_plan(p, m, resolve(m, p), reg)[0]
    assert sub.name == "Serum - Backing"
    assert 1 in sub.exclude
    assert sub.hold_keys == frozenset({1})

def test_output_names_follow_the_convention(simple_als, reg):
    p = read_project(simple_als)
    m = _m({"Arturia - Played": StemSpec(tracks=[TrackRef(2, "Kick")], suffix=" Jup Sync Lead"),
            "Backing": StemSpec(computed=True)},
           [ExtraSpec("Kick & Snare", [TrackRef(2, "Kick")])],
           song="Learning to Feel")
    names = {x.kind: x.output_name for x in build_plan(p, m, resolve(m, p), reg)}
    assert names["stem"] == "Learning to Feel (Arturia - Played) Jup Sync Lead.wav"
    assert names["extra"] == "Learning to Feel (Kick & Snare).wav"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_plan.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'stemkit.plan'`

- [ ] **Step 3: Implement the planner**

Create `src/stemkit/plan.py`:

```python
from __future__ import annotations
from dataclasses import dataclass

from stemkit.als import PRE_MIXER_TAPS
from stemkit.manifest import Manifest, Resolution
from stemkit.model import Project
from stemkit.registry import Registry

@dataclass(frozen=True)
class Pass:
    kind: str
    name: str
    include: frozenset[int]
    exclude: frozenset[int]
    hold_keys: frozenset[int]
    output_name: str

def _hold_keys(project: Project, include: frozenset[int],
               exclude: frozenset[int]) -> frozenset[int]:
    """Excluded tracks that feed a pre-mixer sidechain tap used by an included track."""
    keys: set[int] = set()
    for tid in include:
        for tap in project.by_id[tid].taps:
            if tap.tap in PRE_MIXER_TAPS and tap.key_track_id in exclude:
                keys.add(tap.key_track_id)
        for anc in project.ancestors(tid):
            for tap in anc.taps:
                if tap.tap in PRE_MIXER_TAPS and tap.key_track_id in exclude:
                    keys.add(tap.key_track_id)
    return frozenset(keys)

def build_plan(project: Project, manifest: Manifest, res: Resolution,
               registry: Registry) -> tuple[Pass, ...]:
    audible = frozenset(t.id for t in project.audible())
    song = manifest.song

    ordered = [n for n in manifest.stems if n != "Backing"]
    if "Backing" in manifest.stems:
        ordered.append("Backing")

    passes: list[Pass] = []
    for stem in ordered:
        include = (frozenset(res.backing) if stem == "Backing"
                   else frozenset(t for t, s in res.assigned.items() if s == stem))
        exclude = audible - include
        suffix = manifest.stems[stem].suffix
        passes.append(Pass("stem", stem, include, exclude,
                           _hold_keys(project, include, exclude),
                           f"{song} ({stem}){suffix}.wav"))

    passes.append(Pass("master", "— Master reference —", audible, frozenset(), frozenset(),
                       f"{song} (MASTER REFERENCE).wav"))

    for extra in manifest.extras:
        include = frozenset(
            t.id for t in project.audible()
            if any(r.id == t.id or (r.id is None and r.name == t.name) for r in extra.tracks))
        exclude = audible - include
        passes.append(Pass("extra", extra.name, include, exclude,
                           _hold_keys(project, include, exclude),
                           f"{song} ({extra.name}).wav"))

    return tuple(passes)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_plan.py -v`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add src/stemkit/plan.py tests/test_plan.py
git commit -m "feat: render planner with per-pass exclusion sets and key holds"
```

---

### Task 7: Audio — loudness, gain, and the null test

**Files:**
- Create: `src/stemkit/audio.py`
- Test: `tests/test_audio.py`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure audio).
- Produces:
  - `audio.SumMismatch(Exception)`
  - `audio.read_wav(path) -> tuple[numpy.ndarray, int]` — float64, shape `(frames, channels)`
  - `audio.sum_wavs(paths: Sequence[Path]) -> tuple[numpy.ndarray, int]` — raises `SumMismatch` on differing rate, length, or channel count
  - `audio.measure_lufs(samples, rate) -> float`
  - `audio.true_peak_db(samples) -> float`
  - `audio.gain_for(samples, rate, target_lufs, ceiling_db) -> float` — dB, clamped so the ceiling holds
  - `audio.apply_gain(src: Path, dst: Path, gain_db: float) -> None` — float processing, 24-bit output
  - `audio.null_residual_db(stem_paths, master_path, gain_db=0.0) -> float`

- [ ] **Step 1: Add audio dependencies**

```bash
uv add numpy soundfile pyloudnorm
```

- [ ] **Step 2: Write the failing tests**

Create `tests/test_audio.py`:

```python
import numpy as np
import pytest
import soundfile as sf
from stemkit import audio

def _write(path, data, rate=48000):
    sf.write(path, data, rate, subtype="PCM_24")
    return path

def _tone(freq=440.0, secs=2.0, rate=48000, amp=0.2, channels=2):
    t = np.arange(int(secs * rate)) / rate
    mono = amp * np.sin(2 * np.pi * freq * t)
    return np.column_stack([mono] * channels)

def test_sum_wavs_adds_sample_accurately(tmp_path):
    a, b = _tone(220.0), _tone(660.0)
    _write(tmp_path / "a.wav", a); _write(tmp_path / "b.wav", b)
    total, rate = audio.sum_wavs([tmp_path / "a.wav", tmp_path / "b.wav"])
    assert rate == 48000
    assert np.allclose(total, a + b, atol=1e-4)

def test_sum_rejects_mismatched_sample_rate(tmp_path):
    """Review Focus 4: silently resampling would make the null test lie."""
    _write(tmp_path / "a.wav", _tone(), rate=48000)
    _write(tmp_path / "b.wav", _tone(), rate=44100)
    with pytest.raises(audio.SumMismatch, match="sample rate"):
        audio.sum_wavs([tmp_path / "a.wav", tmp_path / "b.wav"])

def test_sum_rejects_mismatched_length(tmp_path):
    """Review Focus 4: zero-padding would make a short stem look correct."""
    _write(tmp_path / "a.wav", _tone(secs=2.0))
    _write(tmp_path / "b.wav", _tone(secs=1.5))
    with pytest.raises(audio.SumMismatch, match="length"):
        audio.sum_wavs([tmp_path / "a.wav", tmp_path / "b.wav"])

def test_sum_rejects_mismatched_channel_count(tmp_path):
    """Review Focus 4: mono vs stereo must not broadcast silently."""
    _write(tmp_path / "a.wav", _tone(channels=2))
    _write(tmp_path / "b.wav", _tone(channels=1))
    with pytest.raises(audio.SumMismatch, match="channel"):
        audio.sum_wavs([tmp_path / "a.wav", tmp_path / "b.wav"])

def test_gain_moves_loudness_to_target(tmp_path):
    data = _tone(amp=0.5)
    g = audio.gain_for(data, 48000, target_lufs=-18.0, ceiling_db=-6.0)
    moved = data * (10 ** (g / 20))
    assert audio.measure_lufs(moved, 48000) == pytest.approx(-18.0, abs=0.5)

def test_gain_is_clamped_by_the_true_peak_ceiling(tmp_path):
    quiet = _tone(amp=0.001)   # would need a huge boost to hit -18 LUFS
    g = audio.gain_for(quiet, 48000, target_lufs=-18.0, ceiling_db=-6.0)
    assert audio.true_peak_db(quiet * (10 ** (g / 20))) <= -6.0 + 0.01

def test_apply_gain_round_trips(tmp_path):
    src = _write(tmp_path / "s.wav", _tone(amp=0.4))
    audio.apply_gain(src, tmp_path / "d.wav", -6.0)
    out, _ = audio.read_wav(tmp_path / "d.wav")
    orig, _ = audio.read_wav(src)
    assert np.allclose(out, orig * (10 ** (-6.0 / 20)), atol=1e-4)

def test_null_residual_is_silent_for_a_true_partition(tmp_path):
    a, b = _tone(220.0), _tone(660.0)
    _write(tmp_path / "a.wav", a); _write(tmp_path / "b.wav", b)
    _write(tmp_path / "master.wav", a + b)
    r = audio.null_residual_db([tmp_path / "a.wav", tmp_path / "b.wav"], tmp_path / "master.wav")
    assert r < -60.0

def test_null_residual_is_loud_when_a_stem_is_missing(tmp_path):
    a, b = _tone(220.0), _tone(660.0)
    _write(tmp_path / "a.wav", a)
    _write(tmp_path / "master.wav", a + b)
    r = audio.null_residual_db([tmp_path / "a.wav"], tmp_path / "master.wav")
    assert r > -60.0

def test_null_residual_accounts_for_applied_gain(tmp_path):
    a = _tone(220.0)
    _write(tmp_path / "a.wav", a * (10 ** (-8.8 / 20)))
    _write(tmp_path / "master.wav", a)
    assert audio.null_residual_db([tmp_path / "a.wav"], tmp_path / "master.wav",
                                  gain_db=-8.8) < -60.0
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `uv run pytest tests/test_audio.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'stemkit.audio'`

- [ ] **Step 4: Implement the audio module**

Create `src/stemkit/audio.py`:

```python
from __future__ import annotations
from collections.abc import Sequence
from pathlib import Path

import numpy as np
import pyloudnorm as pyln
import soundfile as sf

_EPS = 1e-12

class SumMismatch(Exception):
    """Rendered files disagree on sample rate, length, or channel count."""

def read_wav(path: Path) -> tuple[np.ndarray, int]:
    data, rate = sf.read(str(path), dtype="float64", always_2d=True)
    return data, rate

def sum_wavs(paths: Sequence[Path]) -> tuple[np.ndarray, int]:
    if not paths:
        raise SumMismatch("no files to sum")
    total: np.ndarray | None = None
    rate0 = frames0 = chans0 = None
    for p in paths:
        data, rate = read_wav(p)
        if total is None:
            total, rate0, frames0, chans0 = np.zeros_like(data), rate, *data.shape
        if rate != rate0:
            raise SumMismatch(f"{Path(p).name}: sample rate {rate} != {rate0}")
        if data.shape[0] != frames0:
            raise SumMismatch(f"{Path(p).name}: length {data.shape[0]} != {frames0}")
        if data.shape[1] != chans0:
            raise SumMismatch(f"{Path(p).name}: channel count {data.shape[1]} != {chans0}")
        total = total + data
    return total, rate0

def measure_lufs(samples: np.ndarray, rate: int) -> float:
    return float(pyln.Meter(rate).integrated_loudness(samples))

def true_peak_db(samples: np.ndarray) -> float:
    peak = float(np.max(np.abs(samples))) if samples.size else 0.0
    return 20.0 * np.log10(max(peak, _EPS))

def gain_for(samples: np.ndarray, rate: int, target_lufs: float, ceiling_db: float) -> float:
    wanted = target_lufs - measure_lufs(samples, rate)
    headroom = ceiling_db - true_peak_db(samples)
    return float(min(wanted, headroom))

def apply_gain(src: Path, dst: Path, gain_db: float) -> None:
    data, rate = read_wav(src)
    Path(dst).parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(dst), data * (10.0 ** (gain_db / 20.0)), rate, subtype="PCM_24")

def null_residual_db(stem_paths: Sequence[Path], master_path: Path,
                     gain_db: float = 0.0) -> float:
    stems, rate = sum_wavs(list(stem_paths))
    master, m_rate = read_wav(master_path)
    if m_rate != rate:
        raise SumMismatch(f"master sample rate {m_rate} != stems {rate}")
    if master.shape != stems.shape:
        raise SumMismatch(f"master shape {master.shape} != stems {stems.shape}")
    return true_peak_db(stems / (10.0 ** (gain_db / 20.0)) - master)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv run pytest tests/test_audio.py -v`
Expected: 10 passed

- [ ] **Step 6: Commit**

```bash
git add src/stemkit/audio.py tests/test_audio.py pyproject.toml uv.lock
git commit -m "feat: loudness measurement, per-song gain, and null test"
```

---

### Task 8: Post-processor and CLI

**Files:**
- Create: `src/stemkit/postprocess.py`
- Create: `src/stemkit/cli.py`
- Modify: `pyproject.toml` (add the `stemkit` script entry point)
- Test: `tests/test_postprocess.py`
- Test: `tests/test_cli.py`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `postprocess.safe_component(name: str) -> str` — a filesystem-safe path component
  - `postprocess.destination_for(p: Pass, registry: Registry, song: str) -> Path`
  - `postprocess.Report(files: tuple[Path, ...], applied_gain_db: float, residual_db: float | None, ok: bool)`
  - `postprocess.finish(renders: dict[str, Path], passes, manifest, registry) -> Report` — normalizes with one gain, files everything, runs the null test over stem passes only
  - CLI commands: `stemkit inspect <als>`, `stemkit check <als>`, `stemkit plan <als>`, `stemkit finish <als> --renders <dir>`

- [ ] **Step 1: Write the failing tests**

Create `tests/test_postprocess.py`:

```python
import numpy as np
import pytest
import soundfile as sf
from pathlib import Path
from stemkit.plan import Pass
from stemkit.postprocess import destination_for, finish, safe_component
from stemkit.registry import load_registry
from stemkit.manifest import Manifest, StemSpec

@pytest.fixture
def reg(tmp_path):
    import dataclasses
    return dataclasses.replace(load_registry(Path("registry.yaml")),
                               stems_root=tmp_path / "Stems")

def _tone(freq, secs=1.0, rate=48000, amp=0.2):
    t = np.arange(int(secs * rate)) / rate
    return np.column_stack([amp * np.sin(2 * np.pi * freq * t)] * 2)

def test_safe_component_strips_separators():
    """Review Focus 5: a '/' in a song name must not escape the destination."""
    assert safe_component("AC/DC Tribute") == "AC_DC Tribute"
    assert safe_component("../../etc") == ".._.._etc"
    assert safe_component("") == "untitled"
    assert safe_component("Learning to Feel") == "Learning to Feel"

def test_destination_puts_extras_in_a_subfolder(reg):
    stem = Pass("stem", "Drums", frozenset(), frozenset(), frozenset(), "Song (Drums).wav")
    extra = Pass("extra", "Viola", frozenset(), frozenset(), frozenset(), "Song (Viola).wav")
    assert destination_for(stem, reg, "Song") == reg.stems_root / "Song" / "Song (Drums).wav"
    assert destination_for(extra, reg, "Song") == (
        reg.stems_root / "Song" / "Extras" / "Song (Viola).wav")

def test_finish_applies_one_gain_to_every_file(tmp_path, reg):
    a, b = _tone(220.0), _tone(660.0)
    src = tmp_path / "renders"; src.mkdir()
    sf.write(src / "d.wav", a, 48000, subtype="PCM_24")
    sf.write(src / "k.wav", b, 48000, subtype="PCM_24")
    sf.write(src / "m.wav", a + b, 48000, subtype="PCM_24")
    passes = (
        Pass("stem", "Drums", frozenset(), frozenset(), frozenset(), "Song (Drums).wav"),
        Pass("stem", "Backing", frozenset(), frozenset(), frozenset(), "Song (Backing).wav"),
        Pass("master", "— Master reference —", frozenset(), frozenset(), frozenset(), "m.wav"),
    )
    m = Manifest(song="Song", als="Song.als", target_lufs=-18.0, true_peak_ceiling_db=-6.0,
                 applied_gain_db=None, stems={"Drums": StemSpec(), "Backing": StemSpec()},
                 extras=[])
    rep = finish({"Drums": src / "d.wav", "Backing": src / "k.wav",
                  "— Master reference —": src / "m.wav"}, passes, m, reg)
    out_d, _ = sf.read(reg.stems_root / "Song" / "Song (Drums).wav", always_2d=True)
    out_b, _ = sf.read(reg.stems_root / "Song" / "Song (Backing).wav", always_2d=True)
    ratio_d = np.max(np.abs(out_d)) / np.max(np.abs(a))
    ratio_b = np.max(np.abs(out_b)) / np.max(np.abs(b))
    assert ratio_d == pytest.approx(ratio_b, rel=1e-3)   # one gain, balance preserved
    assert rep.applied_gain_db == pytest.approx(20 * np.log10(ratio_d), abs=0.05)

def test_finish_nulls_for_a_true_partition(tmp_path, reg):
    a, b = _tone(220.0), _tone(660.0)
    src = tmp_path / "renders"; src.mkdir()
    sf.write(src / "d.wav", a, 48000, subtype="PCM_24")
    sf.write(src / "k.wav", b, 48000, subtype="PCM_24")
    sf.write(src / "m.wav", a + b, 48000, subtype="PCM_24")
    passes = (
        Pass("stem", "Drums", frozenset(), frozenset(), frozenset(), "Song (Drums).wav"),
        Pass("stem", "Backing", frozenset(), frozenset(), frozenset(), "Song (Backing).wav"),
        Pass("master", "— Master reference —", frozenset(), frozenset(), frozenset(), "m.wav"),
    )
    m = Manifest(song="Song", als="Song.als", target_lufs=-18.0, true_peak_ceiling_db=-6.0,
                 applied_gain_db=None, stems={"Drums": StemSpec(), "Backing": StemSpec()},
                 extras=[])
    rep = finish({"Drums": src / "d.wav", "Backing": src / "k.wav",
                  "— Master reference —": src / "m.wav"}, passes, m, reg)
    assert rep.residual_db < -60.0 and rep.ok

def test_applied_gain_is_recorded_in_the_manifest(tmp_path, reg):
    """Spec §7 step 6: the gain must be reversible without re-exporting."""
    from stemkit.manifest import load_manifest, save_manifest
    m = Manifest(song="Song", als="Song.als", target_lufs=-18.0, true_peak_ceiling_db=-6.0,
                 applied_gain_db=None, stems={"Drums": StemSpec()}, extras=[])
    path = tmp_path / "stems.yaml"
    m.applied_gain_db = -8.8
    save_manifest(m, path)
    assert load_manifest(path).applied_gain_db == -8.8

def test_finish_reports_failure_when_a_stem_is_missing(tmp_path, reg):
    a, b = _tone(220.0), _tone(660.0)
    src = tmp_path / "renders"; src.mkdir()
    sf.write(src / "d.wav", a, 48000, subtype="PCM_24")
    sf.write(src / "m.wav", a + b, 48000, subtype="PCM_24")
    passes = (
        Pass("stem", "Drums", frozenset(), frozenset(), frozenset(), "Song (Drums).wav"),
        Pass("master", "— Master reference —", frozenset(), frozenset(), frozenset(), "m.wav"),
    )
    m = Manifest(song="Song", als="Song.als", target_lufs=-18.0, true_peak_ceiling_db=-6.0,
                 applied_gain_db=None, stems={"Drums": StemSpec()}, extras=[])
    rep = finish({"Drums": src / "d.wav", "— Master reference —": src / "m.wav"},
                 passes, m, reg)
    assert rep.residual_db > -60.0 and not rep.ok
```

Create `tests/test_cli.py`:

```python
import subprocess, sys
from pathlib import Path

def _run(*args, cwd=None):
    return subprocess.run([sys.executable, "-m", "stemkit.cli", *args],
                          capture_output=True, text=True, cwd=cwd)

def test_inspect_prints_the_track_tree(simple_als):
    r = _run("inspect", str(simple_als))
    assert r.returncode == 0
    assert "Drums" in r.stdout and "Kick" in r.stdout
    assert "2 audible" in r.stdout

def test_check_exits_nonzero_when_blocked(ducked_als, tmp_path):
    (tmp_path / "stems.yaml").write_text(
        "song: Ducked\nals: Ducked.als\nlevel: {target_lufs: -18.0, "
        "true_peak_ceiling_db: -6.0, applied_gain_db: null}\n"
        "stems:\n  Drums:\n    tracks:\n      - {id: 1, name: Kick}\n"
        "  Backing: {computed: true}\nextras: []\n")
    r = _run("check", str(ducked_als))
    assert r.returncode == 1
    assert "master-live" in r.stdout or "Master devices are enabled" in r.stdout

def test_plan_lists_passes_and_exclusions(simple_als, tmp_path):
    (tmp_path / "stems.yaml").write_text(
        "song: Song\nals: Song.als\nlevel: {target_lufs: -18.0, "
        "true_peak_ceiling_db: -6.0, applied_gain_db: null}\n"
        "stems:\n  Drums:\n    tracks:\n      - {id: 2, name: Kick}\n"
        "  Backing: {computed: true}\nextras: []\n")
    r = _run("plan", str(simple_als))
    assert r.returncode == 0
    assert "Drums" in r.stdout and "Bass" in r.stdout   # Bass is excluded from the Drums pass
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_postprocess.py tests/test_cli.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'stemkit.postprocess'`

- [ ] **Step 3: Implement the post-processor**

Create `src/stemkit/postprocess.py`:

```python
from __future__ import annotations
import re
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from stemkit import audio
from stemkit.manifest import Manifest
from stemkit.plan import Pass
from stemkit.registry import Registry

NULL_THRESHOLD_DB = -60.0

_UNSAFE = re.compile(r"[/\\\x00]")

def safe_component(name: str) -> str:
    cleaned = _UNSAFE.sub("_", name).strip()
    return cleaned or "untitled"

def destination_for(p: Pass, registry: Registry, song: str) -> Path:
    base = registry.stems_root / safe_component(song)
    if p.kind == "extra":
        base = base / registry.extras_dir
    return base / safe_component(p.output_name)

@dataclass(frozen=True)
class Report:
    files: tuple[Path, ...]
    applied_gain_db: float
    residual_db: float | None
    ok: bool

def finish(renders: dict[str, Path], passes: Sequence[Pass], manifest: Manifest,
           registry: Registry) -> Report:
    stem_passes = [p for p in passes if p.kind == "stem" and p.name in renders]
    master = next((renders[p.name] for p in passes
                   if p.kind == "master" and p.name in renders), None)

    mix, rate = audio.sum_wavs([renders[p.name] for p in stem_passes])
    gain = audio.gain_for(mix, rate, manifest.target_lufs, manifest.true_peak_ceiling_db)

    written: list[Path] = []
    for p in passes:
        src = renders.get(p.name)
        if src is None or p.kind == "master":
            continue
        dst = destination_for(p, registry, manifest.song)
        audio.apply_gain(src, dst, gain)
        written.append(dst)

    residual = None
    if master is not None:
        residual = audio.null_residual_db(
            [destination_for(p, registry, manifest.song) for p in stem_passes], master, gain)

    return Report(tuple(written), gain, residual,
                  ok=(residual is not None and residual < NULL_THRESHOLD_DB))
```

- [ ] **Step 4: Implement the CLI**

Create `src/stemkit/cli.py`:

```python
from __future__ import annotations
import argparse
import sys
from pathlib import Path

from stemkit.als import read_project
from stemkit.manifest import load_manifest, manifest_path_for, resolve
from stemkit.plan import build_plan
from stemkit.registry import load_registry
from stemkit.validate import blocking, validate

_ICON = {"error": "!", "warn": "▲", "info": "i", "ok": "✓"}

def _registry(args) -> "object":
    return load_registry(Path(args.registry))

def cmd_inspect(args) -> int:
    p = read_project(Path(args.als))
    for t in p.tracks:
        pad = "  " * p.depth(t.id)
        devs = f"   [{', '.join(t.devices)}]" if t.devices else ""
        mute = "  (muted)" if t.muted else ""
        print(f"{pad}{t.name}  <{t.kind}>{devs}{mute}")
        for tap in t.taps:
            print(f"{pad}    ← {tap.key_track_name} ({tap.tap})")
    print(f"\n{len(p.tracks)} tracks, {len(p.audible())} audible")
    print(f"master: {[d.name for d in p.master_devices] or 'clean'}")
    return 0

def _load(args):
    project = read_project(Path(args.als))
    manifest = load_manifest(manifest_path_for(Path(args.als)))
    return project, manifest, resolve(manifest, project), _registry(args)

def cmd_check(args) -> int:
    project, manifest, res, reg = _load(args)
    findings = validate(project, manifest, res, reg)
    for f in findings:
        print(f"{_ICON[f.severity]} {f.severity.upper():5} [{f.rule}] {f.title}")
        print(f"        {f.detail}")
    errs = blocking(findings)
    print(f"\n{len(errs)} error(s), "
          f"{sum(1 for f in findings if f.severity == 'warn')} warning(s)")
    return 1 if errs else 0

def cmd_plan(args) -> int:
    project, manifest, res, reg = _load(args)
    passes = build_plan(project, manifest, res, reg)
    for i, p in enumerate(passes, 1):
        print(f"\n[{i}/{len(passes)}] {p.kind.upper()}  {p.name}")
        print(f"  → {p.output_name}")
        print(f"  mute ({len(p.exclude)}): "
              f"{', '.join(sorted(project.by_id[t].name for t in p.exclude)) or '—'}")
        if p.hold_keys:
            print(f"  fade, do NOT mute (sidechain keys): "
                  f"{', '.join(sorted(project.by_id[t].name for t in p.hold_keys))}")
    return 0

def cmd_finish(args) -> int:
    from stemkit.manifest import save_manifest
    from stemkit.postprocess import finish
    project, manifest, res, reg = _load(args)
    passes = build_plan(project, manifest, res, reg)
    root = Path(args.renders)
    renders = {p.name: root / p.output_name for p in passes
               if (root / p.output_name).exists()}
    missing = [p.name for p in passes if p.name not in renders]
    if missing:
        print(f"missing renders: {', '.join(missing)}", file=sys.stderr)
    report = finish(renders, passes, manifest, reg)
    manifest.applied_gain_db = report.applied_gain_db
    save_manifest(manifest, manifest_path_for(Path(args.als)))
    for f in report.files:
        print(f"  wrote {f}")
    print(f"\napplied gain: {report.applied_gain_db:+.2f} dB")
    print(f"null residual: {report.residual_db:.1f} dBFS"
          if report.residual_db is not None else "null residual: not run")
    print("OK — stems account for the whole mix" if report.ok else "FAILED null test")
    return 0 if report.ok else 1

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="stemkit")
    ap.add_argument("--registry", default="registry.yaml")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name, fn in (("inspect", cmd_inspect), ("check", cmd_check),
                     ("plan", cmd_plan), ("finish", cmd_finish)):
        sp = sub.add_parser(name)
        sp.add_argument("als")
        if name == "finish":
            sp.add_argument("--renders", required=True)
        sp.set_defaults(fn=fn)
    args = ap.parse_args(argv)
    return args.fn(args)

if __name__ == "__main__":
    raise SystemExit(main())
```

Add to `pyproject.toml`:

```toml
[project.scripts]
stemkit = "stemkit.cli:main"
```

- [ ] **Step 5: Run the full suite**

Run: `uv run pytest -v`
Expected: all tests pass (approximately 50)

- [ ] **Step 6: Verify end to end on the real project**

Run:

```bash
uv run stemkit inspect "/Users/stephenkaplan/Documents/Ableton/Project Files/Releases (May 2014 - Present)/Learning to Feel EP/Learning to Feel Project/Learning to Feel.als" | tail -20
```

Expected: the track tree prints with group indentation, the `Bass ← Kick (Post Mixer)` tap is visible, and the summary reads `master: clean`.

- [ ] **Step 7: Commit**

```bash
git add src/stemkit tests pyproject.toml uv.lock
git commit -m "feat: post-processor and CLI"
```

---

## Verification stops

Per the request to stop for verification between major components, these are the natural gates:

| After | What to confirm |
|---|---|
| **Task 2** | The reader agrees with reality on `Learning to Feel.als`: 15 sidechain taps, exactly one `Post Mixer`, empty Master. |
| **Task 5** | Validation findings on a real project match what you'd expect by eye. |
| **Task 6** | The exclusion list for one real stem is what you would actually have soloed. |
| **Task 7** | A null test on two hand-made renders behaves as expected. |
| **Task 8** | Full end-to-end on one real song. |

## Follow-on plans

1. **Live bridge** — remote script applying exclusion state and bypassing Master devices (spec §11 V3: AbletonOSC vs. minimal custom).
2. **Mapping UI** — the web table mocked in `.context/mockup/index.html`.
