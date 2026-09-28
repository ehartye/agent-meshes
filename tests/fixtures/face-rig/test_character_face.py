"""A stylized character (the shared recipe) with a living arkit-face/1 face, walking and jogging.

The body is `stylized_character.build_character` with `face='arkit'`, rigged and animated by
`stylized_walk.rig_character`; `stylized_face.add_face` hangs the eyes under the body's `head` bone and builds the face.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', 'recipes'))
from stylized_character import build_character, landmarks
from stylized_face import add_face
from stylized_walk import rig_character

VALUES = {'height': 1.22, 'age': 'child', 'presentation': 'female', 'skin': '#d6a27c', 'hair': '#614036',
          'eyes': '#3b2a22', 'face': 'arkit'}


def build():
    return add_face(rig_character(build_character(VALUES), landmarks(VALUES), duration=1.1, jog_duration=.75), VALUES)
