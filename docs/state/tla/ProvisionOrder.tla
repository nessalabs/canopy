---- MODULE ProvisionOrder ----
EXTENDS Naturals
VARIABLES phase, failed, aborted, startedSecond, hadFailure, hadAbort
vars == <<phase,failed,aborted,startedSecond,hadFailure,hadAbort>>
Init == /\ phase = "First" /\ failed = FALSE /\ aborted = FALSE
        /\ startedSecond = FALSE /\ hadFailure = FALSE /\ hadAbort = FALSE
FirstDone == /\ phase = "First" /\ phase' = "Between" /\ UNCHANGED <<failed,aborted,startedSecond,hadFailure,hadAbort>>
FirstFails == /\ phase = "First" /\ phase' = "Between" /\ failed' = TRUE /\ UNCHANGED <<aborted,startedSecond,hadFailure,hadAbort>>
Abort == /\ ~aborted /\ aborted' = TRUE /\ UNCHANGED <<phase,failed,startedSecond,hadFailure,hadAbort>>
StartSecond == /\ phase = "Between" /\ ~failed /\ ~aborted
               /\ phase' = "Second" /\ startedSecond' = TRUE /\ hadFailure' = failed /\ hadAbort' = aborted
               /\ UNCHANGED <<failed,aborted>>
Next == FirstDone \/ FirstFails \/ Abort \/ StartSecond
NoStageAfterFailure == ~hadFailure
NoStageAfterObservedAbort == ~hadAbort
====
