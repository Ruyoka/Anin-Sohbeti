package online.aninfotografi.app

import android.annotation.SuppressLint
import android.content.Context
import android.content.DialogInterface
import android.content.res.Configuration
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.CookieManager
import android.net.http.SslError
import android.webkit.SslErrorHandler
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.isGone
import androidx.core.view.isVisible
import online.aninfotografi.app.databinding.ActivityMainBinding

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private val baseHost by lazy { Uri.parse(DEFAULT_URL).host }

    private val exitConfirmationCallback = object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
            if (binding.webView.canGoBack()) {
                binding.webView.goBack()
            } else {
                showExitConfirmation()
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        onBackPressedDispatcher.addCallback(this, exitConfirmationCallback)

        configureWebView()
        binding.retryButton.setOnClickListener { loadContent() }

        if (savedInstanceState != null) {
            binding.webView.restoreState(savedInstanceState)
        } else {
            loadContent()
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        binding.webView.saveState(outState)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        val webSettings = binding.webView.settings
        with(webSettings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            allowFileAccess = false
            allowContentAccess = false
            setAllowFileAccessFromFileURLs(false)
            setAllowUniversalAccessFromFileURLs(false)
            loadsImagesAutomatically = true
            userAgentString = "$CUSTOM_USER_AGENT ${userAgentString}".trim()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                safeBrowsingEnabled = true
            }
        }

        binding.webView.apply {
            isVerticalScrollBarEnabled = true
            isHorizontalScrollBarEnabled = false
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(
                    view: WebView?,
                    request: WebResourceRequest?
                ): Boolean {
                    val url = request?.url ?: return false
                    if (url.scheme.isNullOrEmpty() || (url.scheme != "http" && url.scheme != "https")) {
                        return false
                    }
                    if (!isNetworkAvailable()) {
                        showOfflineState()
                        return true
                    }
                    val destination = ensureThemeQuery(url, currentTheme())
                    view?.loadUrl(destination.toString())
                    return true
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    showWebView()
                }

                override fun onReceivedError(
                    view: WebView?,
                    request: WebResourceRequest?,
                    error: android.webkit.WebResourceError?
                ) {
                    super.onReceivedError(view, request, error)
                    if (request == null || request.isForMainFrame) {
                        showOfflineState()
                    }
                }

                override fun onReceivedSslError(
                    view: WebView?,
                    handler: SslErrorHandler?,
                    error: SslError?
                ) {
                    handler?.cancel()
                    showOfflineState()
                }
            }
        }

        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                setAcceptThirdPartyCookies(binding.webView, true)
            }
        }
    }

    private fun loadContent() {
        if (isNetworkAvailable()) {
            showWebView()
            binding.webView.loadUrl(buildThemedUrl())
        } else {
            showOfflineState()
        }
    }

    private fun showWebView() {
        binding.offlineContainer.isGone = true
        binding.webView.isVisible = true
    }

    private fun showOfflineState() {
        binding.webView.isGone = true
        binding.offlineContainer.isVisible = true
    }

    private fun buildThemedUrl(): String {
        val theme = when (resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) {
            android.content.res.Configuration.UI_MODE_NIGHT_YES -> "dark"
            else -> "light"
        }
        val uri = Uri.parse(DEFAULT_URL)
        return ensureThemeQuery(uri, theme).toString()
    }

    private fun isNetworkAvailable(): Boolean {
        val connectivityManager = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val network = connectivityManager.activeNetwork ?: return false
        val capabilities = connectivityManager.getNetworkCapabilities(network) ?: return false
        return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }

    private fun showExitConfirmation() {
        AlertDialog.Builder(this)
            .setMessage(R.string.exit_confirmation_message)
            .setPositiveButton(R.string.yes) { dialog: DialogInterface, _ ->
                dialog.dismiss()
                finish()
            }
            .setNegativeButton(R.string.no) { dialog: DialogInterface, _ ->
                dialog.dismiss()
            }
            .setCancelable(true)
            .show()
    }

    private fun ensureThemeQuery(uri: Uri, theme: String): Uri {
        if (uri.host != baseHost || !uri.getQueryParameter(THEME_QUERY_KEY).isNullOrEmpty()) {
            return uri
        }
        return uri.buildUpon()
            .appendQueryParameter(THEME_QUERY_KEY, theme)
            .build()
    }

    private fun currentTheme(): String {
        return when (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) {
            Configuration.UI_MODE_NIGHT_YES -> "dark"
            else -> "light"
        }
    }

    companion object {
        private const val DEFAULT_URL = "https://chat.aninfotografi.online"
        private const val THEME_QUERY_KEY = "theme"
        private const val CUSTOM_USER_AGENT = "AninSohbetiApp/1.0 (Android)"
    }
}
