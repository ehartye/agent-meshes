"""Local sdpa shim for flash-attn (toy-maker R4 eval, not upstream).

Both src/model/skin_vae_model.py and src/model/skin_vae/attention_processor.py
try `from flash_attn_interface import flash_attn_func` first; this module on the
repo root satisfies that without building flash-attn for sm_120/Windows.
Signature-compatible subset: q, k, v are (B, L, H, D); returns (out, lse=None).
"""
import torch


def flash_attn_func(q, k, v, *args, **kwargs):
    q = q.permute(0, 2, 1, 3)  # (B, H, L, D)
    k = k.permute(0, 2, 1, 3).to(q.dtype)
    v = v.permute(0, 2, 1, 3).to(q.dtype)
    if q.shape[1] != k.shape[1]:  # GQA: repeat kv heads
        r = q.shape[1] // k.shape[1]
        k = k.repeat_interleave(r, dim=1)
        v = v.repeat_interleave(r, dim=1)
    out = torch.nn.functional.scaled_dot_product_attention(q, k, v)
    return out.permute(0, 2, 1, 3), None  # (B, L, H, D)
