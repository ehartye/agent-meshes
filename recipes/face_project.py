"""Editable project entrypoint for the optional hm08 stylized-character example.

Copy this file and stylized_character.py, stylized_walk.py, stylized_face.py into
the project's authored-input directory. Shared agent_meshes_* modules are
provided by the selected Blender runner; do not copy their implementations.
This example uses metres, Blender Z up and face forward -Y after adaptation.
It intentionally selects the full character/ARKit construction, not all faces.
"""
import stylized_character as character
import stylized_face as face
from stylized_walk import rig_character

DEFINITION = {
    'height': 1.82, 'age': 'adult', 'presentation': 'female', 'face': 'arkit',
    'skin': '#b97d57', 'face_shape': {'years': 30, 'smile': .35},
}
RECIPE = {'parameters': character.parameters, 'landmarks': character.landmarks}


def build():
    values = character.parameters(DEFINITION)
    objects = character.build_character(values)
    objects = rig_character(objects, character.landmarks(values), duration=1.2)
    return face.add_face(objects, values, recipe=RECIPE)
