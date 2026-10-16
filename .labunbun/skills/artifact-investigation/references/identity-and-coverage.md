# Identity and coverage

## Establish identity from bytes

- Record three things for every artifact you cite: the path you read, its size, and a digest of its bytes. The digest is the identity; the path is a location, and the size is only a weak filter.
- Hash methods: sha256sum under Git Bash or certutil -hashfile under cmd both do the job; the method matters less than actually running one and keeping the output with the finding.
- Timestamps identify nothing. Copying, extracting, and touching all rewrite them without changing a byte, so mtime orders events weakly and never pairs artifacts.
- Names identify nothing either: the same name appears across different builds, and the same bytes sit at different paths — an extract, a copy, a backup. When you write "the same artifact", a reader should be able to check a digest, not take your word.
- Extraction and repackaging: anchoring working notes to an extracted location is fine; identity claims go back to the bytes of the source archive. If an extract and its container ever disagree, that disagreement is a finding.
- A digest mismatch invalidates reuse: if what is on disk now hashes differently from what you analyzed earlier, evidence from the two identities never mixes inside one conclusion — re-establish which is which and say which rows moved.

## Order is not identity

Ordinals and list positions — row numbers, module order, address order after a rebuild, the sequence a tool happened to print — move between runs and versions. Pairing records across two artifacts follows a stable key: a content digest; an exact absolute path when both sides demonstrably name the same filesystem object; or an exact, unique name in a namespaced map. When no stable key exists, the pairing is unknown, and a comparison built on unknown pairing only produces hypotheses.

## Comparison rules

- Compare only comparable things: both sides examined with a compatible method at compatible depth. If one side was summarized and the other fully read, the comparison cannot claim more than the weaker side supports.
- "Present on the left, absent on the right" requires the right side to be complete for that kind of record. Against a partial side, the honest result is unknown, not removed — symmetrically for added.
- The identity of "the same item across two versions" comes from content or an exact unique key — never from position, size similarity, or how alike two minified names look. A rename can present as an add plus a remove; only a stable key tells the two stories apart.
- Matching structure is a candidate, not proof: similar shapes suggest a shared origin or a copied module, they establish neither, and they establish nothing about causality. Pair shapes only through exact identifiers, and only when the question actually needs a pairing.

## Coverage accounting

Coverage is a property of each step, not of the investigation. For every step, be able to finish this sentence: "this examined ___, and did not examine ___".

- Kept boundaries: which files of the package, which rows of the table, which pages of the listing, which window of the recording, which entries were truncated.
- Paging and truncation: reading the first page proves the first page. Reaching the end of a page sequence inside a partial source proves nothing about the parts of the source never included. A run that stops early under a resource limit still yields valid observations for the part that completed — keep those, and lower the coverage claim instead of the fact.
- Three results, three sentences: not examined (unknown — say where the gap is), examined with nothing found (a bounded negative — cite the scope), examined and found a contradiction (a finding — record both sides). Parsing failures, unsupported formats, and unreadable inputs belong to the first bucket, never to "absent" or "fine".
- Opaque payloads stay opaque: when a region cannot be interpreted, record where it lives and that it was not interpreted. Do not let a file extension, a magic prefix, or a plausible name upgrade it to an interpretation.
