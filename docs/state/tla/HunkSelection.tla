---- MODULE HunkSelection ----
EXTENDS Naturals
VARIABLES current, offered, representable, wrote, accepted, atPatch, atRepresentable
vars == <<current,offered,representable,wrote,accepted,atPatch,atRepresentable>>
Init == /\ current = 1 /\ offered \in {1,2} /\ representable \in BOOLEAN
        /\ wrote = FALSE /\ accepted = 0 /\ atPatch = 0 /\ atRepresentable = TRUE
Edit == /\ current = 1 /\ current' = 2 /\ UNCHANGED <<offered,representable,wrote,accepted,atPatch,atRepresentable>>
Apply == /\ ~wrote /\ offered = current /\ representable /\ wrote' = TRUE
         /\ accepted' = offered /\ atPatch' = current /\ atRepresentable' = representable
         /\ UNCHANGED <<current,offered,representable>>
Next == Edit \/ Apply
CurrentPatchOnly == wrote => accepted = atPatch
PreserveUnrepresentedIndex == wrote => atRepresentable
====
