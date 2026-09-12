from app.config import Settings


def test_settings_accepts_python_field_names():
    cfg = Settings(
        _env_file=None,
        force_reconcile=True,
        auto_extract_factions=False,
        relation_verify_batch_size=2,
        inject_max_chars=1,
    )

    assert cfg.force_reconcile is True
    assert cfg.auto_extract_factions is False
    assert cfg.relation_verify_batch_size == 2
    assert cfg.inject_max_chars == 1


def test_settings_reads_environment_aliases(monkeypatch):
    monkeypatch.setenv("FORCE_RECONCILE", "true")
    monkeypatch.setenv("AUTO_EXTRACT_FACTIONS", "false")
    monkeypatch.setenv("RELATION_VERIFY_BATCH_SIZE", "3")
    monkeypatch.setenv("INJECT_MAX_CHARS", "7")

    cfg = Settings(_env_file=None)

    assert cfg.force_reconcile is True
    assert cfg.auto_extract_factions is False
    assert cfg.relation_verify_batch_size == 3
    assert cfg.inject_max_chars == 7
