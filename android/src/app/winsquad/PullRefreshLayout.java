package app.winsquad;

import android.animation.ValueAnimator;
import android.content.Context;
import android.util.AttributeSet;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.ViewGroup;
import android.view.animation.DecelerateInterpolator;
import android.widget.FrameLayout;
import android.widget.ProgressBar;

/**
 * Minimal pull-to-refresh for a WebView child. Intercepts only when the
 * content is scrolled to the top; a damped drag reveals a spinner header,
 * and releasing past the trigger fires onRefresh().
 */
public class PullRefreshLayout extends FrameLayout {

    public interface OnRefreshListener {
        void onRefresh();
    }

    private final View header;
    private final int headerH;
    private final int touchSlop;
    private final int triggerPx;
    private final DecelerateInterpolator interpolator = new DecelerateInterpolator();

    private View contentView;
    private OnRefreshListener listener;
    private float downY = -1;
    private float offset = 0;
    private boolean dragging = false;
    private boolean refreshing = false;
    private ValueAnimator animator;

    public PullRefreshLayout(Context context, AttributeSet attrs) {
        super(context, attrs);
        float d = context.getResources().getDisplayMetrics().density;
        touchSlop = ViewConfiguration.get(context).getScaledTouchSlop();
        triggerPx = (int) (96 * d);
        headerH = (int) (72 * d);

        FrameLayout h = new FrameLayout(context);
        ProgressBar pb = new ProgressBar(context);
        // Gold-tinted spinner via color filter (works on all API levels).
        try {
            pb.getIndeterminateDrawable().setColorFilter(0xFFD4AF37,
                    android.graphics.PorterDuff.Mode.SRC_IN);
        } catch (Exception ignored) {}
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.gravity = Gravity.CENTER;
        h.addView(pb, lp);
        addView(h, new LayoutParams(LayoutParams.MATCH_PARENT, headerH));
        header = h;
        header.setTranslationY(-headerH);
    }

    public void setOnRefreshListener(OnRefreshListener l) {
        listener = l;
    }

    @Override
    protected void onFinishInflate() {
        super.onFinishInflate();
        // Child 0 is the header added in the constructor; the WebView is next.
        if (getChildCount() > 1) {
            contentView = getChildAt(1);
        }
    }

    private boolean canChildScrollUp() {
        return contentView != null && contentView.getScrollY() > 0;
    }

    @Override
    public boolean onInterceptTouchEvent(MotionEvent e) {
        if (refreshing) return false;
        switch (e.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                downY = e.getY();
                dragging = false;
                break;
            case MotionEvent.ACTION_MOVE:
                if (downY < 0) downY = e.getY();
                float dy = e.getY() - downY;
                if (dy > touchSlop && !canChildScrollUp()) {
                    dragging = true;
                    return true;
                }
                break;
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL:
                downY = -1;
                dragging = false;
                break;
            default:
                break;
        }
        return super.onInterceptTouchEvent(e);
    }

    @Override
    public boolean onTouchEvent(MotionEvent e) {
        if (!dragging) return super.onTouchEvent(e);
        switch (e.getActionMasked()) {
            case MotionEvent.ACTION_MOVE: {
                float dy = e.getY() - downY;
                if (dy < 0) dy = 0;
                offset = dy * 0.45f; // damping
                applyOffset();
                break;
            }
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL:
                dragging = false;
                downY = -1;
                if (offset >= triggerPx) {
                    refreshing = true;
                    animateOffsetTo(headerH, new Runnable() {
                        @Override public void run() {
                            if (listener != null) listener.onRefresh();
                        }
                    });
                } else {
                    animateOffsetTo(0, null);
                }
                break;
            default:
                break;
        }
        return true;
    }

    private void applyOffset() {
        float capped = Math.min(offset, headerH * 2.5f);
        header.setTranslationY(-headerH + Math.min(capped, headerH));
        if (contentView != null) contentView.setTranslationY(capped);
    }

    private void animateOffsetTo(float target, final Runnable end) {
        if (animator != null) animator.cancel();
        animator = ValueAnimator.ofFloat(offset, target);
        animator.setDuration(220);
        animator.setInterpolator(interpolator);
        animator.addUpdateListener(new ValueAnimator.AnimatorUpdateListener() {
            @Override public void onAnimationUpdate(ValueAnimator a) {
                offset = (float) a.getAnimatedValue();
                applyOffset();
            }
        });
        if (end != null) {
            animator.addListener(new android.animation.AnimatorListenerAdapter() {
                @Override public void onAnimationEnd(android.animation.Animator a) {
                    end.run();
                }
            });
        }
        animator.start();
    }

    /** Call when the refresh work (page reload) has settled. */
    public void setRefreshing(boolean r) {
        refreshing = r;
        if (!r) animateOffsetTo(0, null);
    }

    public boolean isRefreshing() {
        return refreshing;
    }
}
