# hm08 head data (CC0)

These files are data only. No MakeHuman or MPFB program code is used or vendored.

- `hm08_head.npz` holds the head and upper neck of the MakeHuman hm08 base mesh: vertices, quads and helper
  geometry (eyes, teeth, tongue and lashes). It also holds the joint helpers' centers, the mirror table and 316
  targets restricted to those vertices. Those targets are:
  - the race, gender and age macros;
  - the head, face-feature and neck modifiers;
  - faceunits01, the 52 ARKit face units by Mika Suominen.

  `python scripts/hm08-vendor.py` rebuilds the file from the pinned sources in `SOURCES.json`, checking each
  file's SHA-256. The sources are the makehumancommunity `mpfb2` assets (CC0 1.0, LICENSE.ASSETS.md) and
  `extra-targets` (CC0 1.0).
- `stylize01.target` is our own stylize delta, derived by `python scripts/hm08-stylize.py`. It fits hm08 onto
  Blender Studio's stylized head from the Human Base Meshes bundle v1.4.1 (CC0 1.0), which is pinned by SHA-256.
  `stylize01.json` records the source, the landmark pairs and the fit report.

Units are MakeHuman's: decimeters, Y up, and the face looks down +Z. `agent_meshes_hm08.to_blender` maps them to
Blender meters, with Z up and the face looking down -Y.
