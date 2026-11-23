# Conformance Test Vectors

`v1.json` holds fixed inputs and the exact outputs an implementation of the
Fiber Offers v1 format must produce for them, together with inputs it must
refuse. The format itself is specified in [`../spec-v1.md`](../spec-v1.md).

An implementation conforms when it reproduces every output in the file and
refuses every invalid case. Matching the reference implementation's error
codes is recommended, not required.

## Checking an implementation

Two implementations in this repository are checked against the file:

```bash
node --test packages/protocol/test/vectors.test.js   # @fiber-offers/protocol
python3 docs/test-vectors/verify.py                  # independent, in Python
```

A fixed list of cases can only pin down the cases someone thought of. So the
two implementations are also compared directly
(`packages/protocol/test/independent-verifier.test.js`): each valid offer in
the file is changed in one place, some 14,000 ways in all, and both must give
the same verdict on every result. `verify.py --offers` reads one offer per
line and answers `accept` or `refuse` for each, judging its form only;
`--signed-offers` verifies in full. Another implementation can be compared the
same way.

`verify.py` was written from the specification and shares no code with the
JavaScript package. It exists to show that the specification is complete
enough to implement elsewhere, and it is a compact second reference to read
when porting: canonical JSON, Bech32m, signature checks, the canonical-form
rules and the CKB type script hash are each a short function.

## What the file contains

| Section | Cases | What is fixed |
| --- | --- | --- |
| `keys` | 3 | Ed25519 test keys, each derived from a published seed label (`seed = SHA-256(label)`), as PEM and as the raw 32-byte public key. The subscriber key carries its subscription ID |
| `canonical_json` | 8 | `input_json` and its canonical text: key order (including number-like keys and non-ASCII keys), escaping, a member named `__proto__` |
| `type_script_hashes` | 3 | A CKB script and the `type_script_hash` an offer carries for it |
| `valid_offers` | 13 | For each offer: the ID preimage, the ID, the signing payload, the signature, the canonical JSON, and the encoded form in lowercase and uppercase |
| `normalization` | 1 | Loosely written input and the offer ID it must normalize to |
| `invalid_offers` | 34 | Offers that must be refused, most of them validly signed: non-canonical spellings, a P-256 key, unknown fields, contradictory terms, content nested too deep, a malformed signature object, an unsigned `__proto__` member |
| `invalid_encoded_offers` | 11 | Strings that must be refused: damaged, mixed case, another prefix, a body that is not the canonical JSON |
| `resolution_requests` | 11 | A request against an offer at a given time, and what it resolves to or why it is refused |
| `revocations` | 7 | Revocation proofs at a given time, and whether they hold |
| `recurrence_requests` | 8 | Signed cycle requests for a recurring offer, and whether they hold |

Every vector has a `name`; many have a `note` saying what it is for. Unless a
vector gives its own `now`, the current time is the file's top-level `now`
(unix seconds).

`invalid_offers` entries carry the offer as a JSON object in `offer`, except
where the case depends on the JSON text itself (a member named `__proto__`),
which is given as a string in `offer_json`.

## The test keys

The keys in the file are public. They are derived from the labels printed
beside them and exist only so that signatures can be reproduced. Never use
them for a real offer.

## Changing the file

The file is the reference and is frozen: a change to a case in it is a change
to the format. Cases can be added where the specification was found to leave
something open; `vectors_version` counts those revisions. Revision 2 added the
four cases at the nesting-depth limit and changed no earlier case. `scripts/generate-test-vectors.js` documents how it was produced and
reproduces it byte for byte. It keeps the one vector that cannot be
regenerated identically (the P-256 signature, which is randomized) from the
committed file.
