from src.strutils import dedupe


def test_dedupe_preserves_first_occurrence_order():
    assert dedupe([3, 1, 3, 2, 1]) == [3, 1, 2]


def test_dedupe_empty_list():
    assert dedupe([]) == []
