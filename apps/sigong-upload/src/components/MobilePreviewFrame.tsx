import React, { useState } from 'react';
import { RefreshCw } from 'lucide-react';

/** 갤럭시 S 일반 모델의 CSS 픽셀 크기. 가장 작은 축이 아니라 가장 흔한 축입니다. */
const PHONE = { width: 360, height: 780 };

/** 미리보기 안에서 또 미리보기가 열리지 않게 하는 표시. */
export const PREVIEW_PARAM = 'preview';

export function isPreviewFrame(): boolean {
  try {
    return new URLSearchParams(window.location.search).get(PREVIEW_PARAM) === '1';
  } catch {
    return false;
  }
}

/**
 * 기사 화면을 휴대폰 크기 안에서 그대로 확인하는 틀.
 *
 * div 를 360px 로 좁히는 대신 **iframe** 을 씁니다. 이 선택이 핵심입니다 —
 * Tailwind 의 `sm:` 같은 규칙은 요소의 너비가 아니라 **창**의 너비를 봅니다.
 * div 를 좁히면 겉모습만 좁아지고 안쪽은 여전히 데스크톱 배치로 그려져서,
 * "휴대폰에서 이렇게 보인다"는 확인이 거짓이 됩니다. 화면을 덮는 팝업
 * (`position: fixed`)도 마찬가지로 틀을 뚫고 브라우저 전체를 덮어 버려,
 * 정작 확인하려던 것을 확인할 수 없었습니다.
 *
 * iframe 은 창 자체가 360px 이므로 화면 크기에 걸린 규칙도 팝업도 실제
 * 휴대폰과 똑같이 동작합니다.
 */
export const MobilePreviewFrame: React.FC = () => {
  /** 값을 바꾸면 iframe 이 다시 뜹니다 — 설정을 바꾼 뒤 확인할 때 씁니다. */
  const [nonce, setNonce] = useState(0);

  return (
    <div className="py-6 px-4 flex flex-col items-center">
      <div className="flex items-center gap-2 mb-3">
        <p className="text-xs font-semibold text-slate-500">
          모바일 미리보기 · 갤럭시 S 일반 ({PHONE.width} × {PHONE.height})
        </p>
        <button
          type="button"
          onClick={() => setNonce((value) => value + 1)}
          title="미리보기 새로고침"
          className="p-1.5 rounded-lg border border-slate-300 text-slate-500"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="rounded-[2rem] border-8 border-slate-800 bg-slate-800 shadow-2xl">
        <iframe
          key={nonce}
          title="휴대폰 미리보기"
          src={`${window.location.pathname}?${PREVIEW_PARAM}=1`}
          width={PHONE.width}
          height={PHONE.height}
          className="block rounded-[1.4rem] bg-white"
        />
      </div>

      <p className="mt-2 text-[11px] text-slate-500 max-w-[360px] text-center">
        실제 휴대폰과 같은 창 크기입니다. 이 안에서 열리는 팝업도 휴대폰에서와 똑같이,
        이 틀 안에서 열립니다.
      </p>
    </div>
  );
};
