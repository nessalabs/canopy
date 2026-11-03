---- MODULE PermissionDecision ----
EXTENDS Naturals
VARIABLES current, offered, pending, forced, allowed, accepted, automatic
vars == <<current,offered,pending,forced,allowed,accepted,automatic>>
Init == /\ current \in {1,2} /\ offered \in {1,2} /\ pending = TRUE
        /\ forced \in BOOLEAN /\ allowed = FALSE /\ accepted = 0 /\ automatic = FALSE
Reply == /\ pending /\ offered = current /\ pending' = FALSE /\ allowed' = TRUE
         /\ accepted' = offered /\ UNCHANGED <<current,offered,forced,automatic>>
AutoAllow == /\ pending /\ ~forced /\ pending' = FALSE /\ allowed' = TRUE
             /\ accepted' = current /\ automatic' = TRUE /\ UNCHANGED <<current,offered,forced>>
Abort == /\ pending /\ pending' = FALSE /\ UNCHANGED <<current,offered,forced,allowed,accepted,automatic>>
Next == Reply \/ AutoAllow \/ Abort
CurrentRequestOnly == allowed => accepted = current
ForcedAskRequiresReply == automatic => ~forced
====
