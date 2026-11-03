---- MODULE ServiceCallback ----
EXTENDS Naturals
VARIABLES generation, offered, disposed, published, accepted, atGeneration, wasDisposed
vars == <<generation,offered,disposed,published,accepted,atGeneration,wasDisposed>>
Init == /\ generation = 1 /\ offered \in {1,2} /\ disposed = FALSE
        /\ published = FALSE /\ accepted = 0 /\ atGeneration = 0 /\ wasDisposed = FALSE
Replace == /\ generation = 1 /\ generation' = 2 /\ UNCHANGED <<offered,disposed,published,accepted,atGeneration,wasDisposed>>
Dispose == /\ ~disposed /\ disposed' = TRUE /\ UNCHANGED <<generation,offered,published,accepted,atGeneration,wasDisposed>>
HealthReply == /\ ~published /\ offered <= generation /\ offered = generation /\ ~disposed
               /\ published' = TRUE /\ accepted' = offered /\ atGeneration' = generation /\ wasDisposed' = disposed
               /\ UNCHANGED <<generation,offered,disposed>>
Next == Replace \/ Dispose \/ HealthReply
CurrentCallbackOnly == published => accepted = atGeneration
NoDisposedPublish == ~wasDisposed
====
