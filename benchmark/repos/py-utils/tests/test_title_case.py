from src.strutils import title_case


def test_title_case_single_word():
    assert title_case("hello") == "Hello"


def test_title_case_multiple_words():
    assert title_case("hello world") == "Hello World"
