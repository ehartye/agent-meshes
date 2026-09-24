"""Robot variant of the arkit-face/1 test head: shutter eyes, grille teeth and a rigid hinged chin plate."""
from test_head import build_face


def build():
    return build_face(robot=True)
