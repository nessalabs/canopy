-- Lines each hunk adds and removes, so the Graph pane can say whether a node mostly adds or
-- mostly removes code. Graphs made before this have none and show no split.
ALTER TABLE review_graphs ADD COLUMN lines_json TEXT;
