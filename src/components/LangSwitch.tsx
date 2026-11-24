import { useState } from "react";
import { getLang, Lang, setLang } from "../i18n";

export default function LangSwitch(props: { floating?: boolean }) {
  const [cur, setCur] = useState<Lang>(getLang());
  const pick = (l: Lang) => {
    setLang(l);
    setCur(l);
    window.dispatchEvent(new Event("shoppos-lang"));
  };
  return (
    <div className={`lang-switch ${props.floating ? "lang-floating" : ""}`} data-no-translate data-testid="lang-switch">
      <button className={cur === "en" ? "on" : ""} onClick={() => pick("en")} data-testid="lang-en">
        ENG
      </button>
      <button className={cur === "ur" ? "on" : ""} onClick={() => pick("ur")} lang="ur" data-testid="lang-ur">
        اردو
      </button>
    </div>
  );
}
