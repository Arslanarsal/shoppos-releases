use pos_core::license;

#[test]
fn activation_works_only_on_its_own_computer() {
    let dir = tempfile::tempdir().unwrap();
    let code = license::computer_code("machine-a");
    assert_eq!(code.len(), 19);
    assert_eq!(code, license::computer_code(" MACHINE-A "));
    assert_ne!(code, license::computer_code("machine-b"));
    assert!(license::verify("ABCD-1234-ABCD-1234", "UsTMvU6lLm7ltKQxNksO0eUAabeZR634ge4RbuN1_zVE0qD9RMKI577BPzwbrD7Nw1UZaL5ykByp0ET-gPIuCg"));
    assert!(license::verify("abcd-1234-abcd-1234", " UsTMvU6lLm7ltKQxNksO0eUAabeZR634ge4RbuN1_zVE0qD9RMKI577BPzwbrD7Nw1UZaL5ykByp0ET-gPIuCg \n"));
    assert!(!license::verify("ABCD-1234-ABCD-1235", "UsTMvU6lLm7ltKQxNksO0eUAabeZR634ge4RbuN1_zVE0qD9RMKI577BPzwbrD7Nw1UZaL5ykByp0ET-gPIuCg"));
    assert!(!license::verify("ABCD-1234-ABCD-1234", "xUsTMvU6lLm7ltKQxNksO0eUAabeZR634ge4RbuN1_zVE0qD9RMKI577BPzwbrD7Nw1UZaL5ykByp0ET-gPIuCg"));
    assert_eq!(license::status(dir.path(), "machine-a")["ok"], false);
    assert!(license::activate(dir.path(), "machine-a", "UsTMvU6lLm7ltKQxNksO0eUAabeZR634ge4RbuN1_zVE0qD9RMKI577BPzwbrD7Nw1UZaL5ykByp0ET-gPIuCg").is_err());
}

#[test]
fn computer_code_matches_the_developer_tool() {
    assert_eq!(license::computer_code("machine-a"), "36DD-9769-D036-CF2E");
}
