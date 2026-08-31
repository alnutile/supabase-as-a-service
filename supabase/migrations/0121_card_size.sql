-- ---------------------------------------------------------------------------
-- 0121 — card size (Cards board)
--
-- A card on a Planner card board can now be RESIZED: bigger = more visual
-- weight, the same way its position is the priority ranking. The size lives on
-- the existing `card_boards.cards` jsonb ({..., w, h}), so there is no schema
-- change here — this migration only re-seeds the two card-authoring builtins so
-- the assistant (and, via the MCP server, an external Claude) can ask for a
-- named size when it dumps ideas onto a board.
--
-- Cards written before this migration simply have no w/h and render at the
-- default size; the readers clamp/default in code.
-- ---------------------------------------------------------------------------

update public.tools
set
  description = 'Create a card board in the Planner — a free-form wall of movable cards for laying out ideas by priority (not a Kanban). Optionally seed it with `cards`: an array of {text, color?, size?} (color one of yellow|pink|green|blue|purple|gray; size one of small|medium|large|huge — a bigger card reads as a bigger idea). Optionally file it into a collection (by name; created if missing).',
  input_schema = '{"type":"object","properties":{"title":{"type":"string","description":"The board title."},"cards":{"type":"array","description":"Optional cards to seed: each {text, color?, size?}.","items":{"type":"object","properties":{"text":{"type":"string"},"color":{"type":"string"},"size":{"type":"string","description":"small | medium (default) | large | huge — the card''s visual weight."}},"required":["text"]}},"collection":{"type":"string","description":"Optional collection name (or id) to file this board into; created if missing."}},"required":["title"]}'::jsonb
where name = 'create_card_board' and is_builtin;

update public.tools
set
  description = 'Add cards to an existing board (identify it by id or exact title). Pass `cards`: an array of {text, color?, size?} (color one of yellow|pink|green|blue|purple|gray; size one of small|medium|large|huge — a bigger card reads as a bigger idea). The cards are auto-positioned on the canvas; the user can then drag them to rank by priority and resize them.',
  input_schema = '{"type":"object","properties":{"id":{"type":"string","description":"The board id (or use title)."},"title":{"type":"string","description":"The exact board title (alternative to id)."},"cards":{"type":"array","description":"Cards to add: each {text, color?, size?}.","items":{"type":"object","properties":{"text":{"type":"string"},"color":{"type":"string"},"size":{"type":"string","description":"small | medium (default) | large | huge — the card''s visual weight."}},"required":["text"]}}},"required":["cards"]}'::jsonb
where name = 'add_cards' and is_builtin;
